"""Language Practice Room Flask application.

WebRTC media stays between browsers.  This server provides REST polling for
small-room signaling, speech-to-text, and protected Gemini grammar feedback.
"""

from __future__ import annotations

import io
import json
import os
import re
import time
import uuid
from collections import defaultdict
from threading import Lock

import speech_recognition as sr
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from supabase import Client, create_client

ENV_PATH = os.path.join(os.path.abspath(os.path.dirname(__file__)), ".env")
load_dotenv(ENV_PATH, override=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 12 * 1024 * 1024  # 12 MB audio limit

MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
FALLBACK_MODEL_NAME = os.getenv("GEMINI_FALLBACK_MODEL", "gemini-3.5-flash-lite")
SIGNAL_TTL_SECONDS = 15 * 60
MAX_ROOM_MEMBERS = 2
_rooms: dict[str, dict[str, object]] = defaultdict(lambda: {"peers": {}, "signals": [], "mode": None})
_rooms_lock = Lock()
_supabase: Client | None = None


def supabase_client():
    global _supabase
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return None
    if _supabase is None:
        _supabase = create_client(url, key)
    return _supabase


def supabase_room_table(client):
    return client.table(os.getenv("SUPABASE_ROOM_TABLE", "rooms"))


def webrtc_ice_servers() -> list[dict[str, object]]:
    default_servers: list[dict[str, object]] = [
        {"urls": "stun:stun.l.google.com:19302"}
    ]
    configured_servers = os.getenv("WEBRTC_ICE_SERVERS", "").strip()
    if not configured_servers:
        return default_servers

    try:
        servers = json.loads(configured_servers)
    except json.JSONDecodeError:
        app.logger.warning("WEBRTC_ICE_SERVERS is not valid JSON; using the default STUN server")
        return default_servers

    if not isinstance(servers, list) or not servers or any(
        not isinstance(server, dict)
        or not isinstance(server.get("urls"), (str, list))
        or (isinstance(server.get("urls"), list) and not all(isinstance(url, str) for url in server["urls"]))
        for server in servers
    ):
        app.logger.warning("WEBRTC_ICE_SERVERS has an invalid format; using the default STUN server")
        return default_servers
    return servers

TOPICS = [
    {"title": "Weekend plans", "prompt": "What would you like to do this weekend, and why?"},
    {"title": "A memorable meal", "prompt": "Describe a meal you enjoyed and who you shared it with."},
    {"title": "Travel wish list", "prompt": "Which place would you like to visit? Explain what attracts you."},
    {"title": "Learning something new", "prompt": "Talk about a skill you want to learn and your first step."},
    {"title": "Small daily wins", "prompt": "What is one good thing that happened today?"},
    {"title": "A helpful invention", "prompt": "Choose an invention you use often. How does it help people?"},
    {"title": "A place that feels like home", "prompt": "Describe a place where you feel comfortable and explain why."},
    {"title": "Food and culture", "prompt": "What food from your culture would you recommend to a visitor?"},
    {"title": "A future goal", "prompt": "What is one goal you hope to achieve in the next year?"},
    {"title": "Books, films, or music", "prompt": "What story or song has stayed with you recently?"},
    {"title": "Technology in daily life", "prompt": "Which technology makes your day easier, and what would you change about it?"},
]


def error(message: str, status: int = 400):
    return jsonify({"error": message}), status


def clean_expired_rooms() -> None:
    now = time.time()
    for code in list(_rooms):
        room = _rooms[code]
        peers = room["peers"]
        room["peers"] = {peer_id: value for peer_id, value in peers.items() if now - value["seen"] < SIGNAL_TTL_SECONDS}
        room["signals"] = [signal for signal in room["signals"] if now - signal["created"] < SIGNAL_TTL_SECONDS]
        if not room["peers"] and not room["signals"]:
            del _rooms[code]


def room_code(value: str) -> str:
    return re.sub(r"[^A-Z0-9-]", "", value.upper())[:32]


@app.get("/")
def index():
    return render_template("index.html", topics=TOPICS)


@app.get("/create")
def create_room_page():
    mode = "chat" if request.args.get("mode") == "chat" else "video"
    return render_template("create.html", topics=TOPICS, room_mode=mode)


@app.get("/join")
def join_room_page():
    code = request.args.get("code", "")
    return render_template("join.html", prefill_code=code, topics=TOPICS)


@app.get("/room/<room_code_val>")
def room_page(room_code_val: str):
    code = room_code(room_code_val)
    mode = "chat" if request.args.get("mode") == "chat" else "video"
    return render_template("room.html", room_code=code, room_mode=mode, topics=TOPICS, ice_servers=webrtc_ice_servers())


@app.get("/room")
def room_query():
    code = room_code(request.args.get("code", ""))
    if not code:
        from flask import redirect, url_for
        return redirect(url_for("join_room_page"))
    mode = "chat" if request.args.get("mode") == "chat" else "video"
    return render_template("room.html", room_code=code, room_mode=mode, topics=TOPICS, ice_servers=webrtc_ice_servers())


@app.get("/api/topics")
def topics():
    return jsonify({"topics": TOPICS})


@app.get("/api/rooms/status")
def room_status_check():
    code = room_code(request.args.get("room", ""))
    if not code:
        return error("Room code required")
    client = supabase_client()
    if client:
        rows = supabase_room_table(client).select("peer_id,data").eq("room_code", code).execute().data or []
        peer_rows = [row for row in rows if row.get("data", {}).get("type") == "peer"]
        count = len(peer_rows)
        mode = peer_rows[0].get("data", {}).get("mode", "video") if peer_rows else "video"
    else:
        with _rooms_lock:
            clean_expired_rooms()
            room = _rooms.get(code)
            count = len(room["peers"]) if room else 0
            mode = room.get("mode", "video") if room else "video"
    return jsonify({"room": code, "peerCount": count, "exists": count > 0, "maxMembers": MAX_ROOM_MEMBERS, "available": count < MAX_ROOM_MEMBERS, "mode": mode})


@app.post("/api/rooms/join")
def join_room():
    data = request.get_json(silent=True) or {}
    code = room_code(str(data.get("room", "")))
    peer_id = str(data.get("peerId", ""))[:80]
    name = str(data.get("name", "Guest"))[:30].strip() or "Guest"
    is_host = data.get("host") is True
    requested_mode = str(data.get("mode", "video"))
    if requested_mode not in {"video", "chat"}:
        return error("Unsupported room mode.")
    if len(code) < 3 or not peer_id:
        return error("Enter a room code of at least 3 characters.")
    client = supabase_client()
    if client:
        table = supabase_room_table(client)
        rows = table.select("id,peer_id,data").eq("room_code", code).execute().data or []
        peer_rows = [row for row in rows if row.get("data", {}).get("type") == "peer"]
        existing = next((row for row in peer_rows if row["peer_id"] == peer_id), None)
        if not peer_rows and not is_host:
            return error("Room not found. Check the room code and try again.", 404)
        if not existing and len(peer_rows) >= MAX_ROOM_MEMBERS:
            return error(f"This practice room already has {MAX_ROOM_MEMBERS} people.", 409)
        mode = peer_rows[0].get("data", {}).get("mode", "video") if peer_rows else requested_mode
        peer_data = {"type": "peer", "name": name, "seen": time.time(), "mode": mode}
        if existing:
            table.update({"data": peer_data}).eq("id", existing["id"]).execute()
        else:
            table.insert({"room_code": code, "peer_id": peer_id, "data": peer_data}).execute()
        peer_rows = table.select("peer_id,data").eq("room_code", code).execute().data or []
        other_peers = [{"id": row["peer_id"], "name": row["data"].get("name", "Guest")} for row in peer_rows if row.get("data", {}).get("type") == "peer" and row["peer_id"] != peer_id]
    else:
        with _rooms_lock:
            clean_expired_rooms()
            if code not in _rooms and not is_host:
                return error("Room not found. Check the room code and try again.", 404)
            room = _rooms[code]
            peers = room["peers"]
            if peer_id not in peers and len(peers) >= MAX_ROOM_MEMBERS:
                return error(f"This practice room already has {MAX_ROOM_MEMBERS} people.", 409)
            if not peers:
                room["mode"] = requested_mode
            mode = room.get("mode") or "video"
            peers[peer_id] = {"name": name, "seen": time.time()}
        other_peers = [{"id": key, "name": value["name"]} for key, value in peers.items() if key != peer_id]
    return jsonify({"room": code, "peers": other_peers, "mode": mode})


@app.post("/api/rooms/signal")
def send_signal():
    data = request.get_json(silent=True) or {}
    code = room_code(str(data.get("room", "")))
    sender = str(data.get("from", ""))[:80]
    recipient = str(data.get("to", ""))[:80]
    message = data.get("message")
    if not code or not sender or not recipient or not isinstance(message, dict):
        return error("Invalid signaling message.")
    if message.get("type") not in {"offer", "answer", "candidate"}:
        return error("Unsupported signaling message.")
    signal_item = {"id": uuid.uuid4().hex, "from": sender, "to": recipient, "message": message, "created": time.time()}
    client = supabase_client()
    if client:
        table = supabase_room_table(client)
        rows = table.select("peer_id,data").eq("room_code", code).execute().data or []
        peers = {row["peer_id"] for row in rows if row.get("data", {}).get("type") == "peer"}
        if sender not in peers or recipient not in peers:
            return error("Join the room before signaling.", 404)
        table.insert({"room_code": code, "peer_id": recipient, "data": {"type": "signal", "id": signal_item["id"], "from": sender, "to": recipient, "message": message, "created": signal_item["created"]}}).execute()
    else:
        with _rooms_lock:
            room = _rooms.get(code)
            if not room or sender not in room["peers"] or recipient not in room["peers"]:
                return error("Join the room before signaling.", 404)
            room["peers"][sender]["seen"] = time.time()
            room["signals"].append(signal_item)
    return jsonify({"ok": True})


@app.get("/api/rooms/poll")
def poll_room():
    code = room_code(request.args.get("room", ""))
    peer_id = request.args.get("peerId", "")[:80]
    if not code or not peer_id:
        return error("A room and peer ID are required.")
    client = supabase_client()
    if client:
        table = supabase_room_table(client)
        rows = table.select("id,peer_id,data").eq("room_code", code).execute().data or []
        stale_ids = [
            row["id"] for row in rows
            if row.get("data", {}).get("type") == "peer"
            and time.time() - float(row["data"].get("seen", 0)) >= SIGNAL_TTL_SECONDS
        ]
        if stale_ids:
            table.delete().in_("id", stale_ids).execute()
            rows = [row for row in rows if row["id"] not in stale_ids]
        member = next((row for row in rows if row["peer_id"] == peer_id and row.get("data", {}).get("type") == "peer"), None)
        if not member:
            return error("Room session expired. Join again.", 404)
        member["data"]["seen"] = time.time()
        table.update({"data": member["data"]}).eq("id", member["id"]).execute()
        signal_rows = [row for row in rows if row.get("data", {}).get("type") == "signal" and row.get("data", {}).get("to") == peer_id]
        received = [row["data"] | {"id": row["data"].get("id", row["id"])} for row in signal_rows]
        if signal_rows:
            table.delete().in_("id", [row["id"] for row in signal_rows]).execute()
        peers_data = [row for row in rows if row.get("data", {}).get("type") == "peer"]
        peers = [{"id": row["peer_id"], "name": row["data"].get("name", "Guest")} for row in peers_data if row["peer_id"] != peer_id]
    else:
        with _rooms_lock:
            clean_expired_rooms()
            room = _rooms.get(code)
            if not room or peer_id not in room["peers"]:
                return error("Room session expired. Join again.", 404)
            room["peers"][peer_id]["seen"] = time.time()
            received = [item for item in room["signals"] if item["to"] == peer_id]
            room["signals"] = [item for item in room["signals"] if item["to"] != peer_id]
            peers = [{"id": key, "name": value["name"]} for key, value in room["peers"].items() if key != peer_id]
    return jsonify({"signals": received, "peers": peers})


@app.post("/api/rooms/leave")
def leave_room():
    data = request.get_json(silent=True) or {}
    code, peer_id = room_code(str(data.get("room", ""))), str(data.get("peerId", ""))[:80]
    client = supabase_client()
    if client:
        table = supabase_room_table(client)
        rows = table.select("id,peer_id,data").eq("room_code", code).execute().data or []
        ids = [row["id"] for row in rows if row["peer_id"] == peer_id or row.get("data", {}).get("from") == peer_id or row.get("data", {}).get("to") == peer_id]
        if ids:
            table.delete().in_("id", ids).execute()
    else:
        with _rooms_lock:
            room = _rooms.get(code)
            if room:
                room["peers"].pop(peer_id, None)
                room["signals"] = [item for item in room["signals"] if item["from"] != peer_id and item["to"] != peer_id]
    return jsonify({"ok": True})


@app.post("/api/transcribe")
def transcribe():
    """Recognize audio via Python SpeechRecognition."""
    audio_file = request.files.get("audio")
    if not audio_file:
        return error("Attach a WAV audio clip in the 'audio' field.")
    if not audio_file.filename.lower().endswith(".wav"):
        return error("Please upload WAV audio.")
    try:
        recognizer = sr.Recognizer()
        with sr.AudioFile(io.BytesIO(audio_file.read())) as source:
            audio = recognizer.record(source)
        transcript = recognizer.recognize_google(audio, language="en-US")
        return jsonify({"transcript": transcript})
    except sr.UnknownValueError:
        return error("Could not understand that audio clip. Try speaking closer to the microphone.", 422)
    except sr.RequestError as exc:
        app.logger.warning("SpeechRecognition request failed: %s", exc)
        return error("SpeechRecognition service request failed.", 503)
    except Exception:
        app.logger.exception("Transcription failed")
        return error("The audio clip could not be processed. Please try another recording.", 422)



@app.post("/api/grammar")
def grammar():
    data = request.get_json(silent=True) or {}
    transcript = str(data.get("transcript", "")).strip()
    if not transcript:
        return error("Provide some recognized speech to check.")
    if len(transcript) > 2_000:
        return error("Please check no more than 2,000 characters at a time.")
    load_dotenv(ENV_PATH, override=True)
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return error("The server is missing GEMINI_API_KEY. Add it to .env locally or Vercel environment variables.", 503)
    model_name = os.getenv("GEMINI_MODEL", MODEL_NAME)
    prompt = f'''You are a warm English conversation coach. Analyze this learner transcript:
{transcript!r}

Return ONLY valid JSON with this exact shape:
{{"corrected":"...","summary":"...","issues":[{{"original":"...","correction":"...","explanation":"..."}}]}}
Keep corrections natural and preserve the learner's meaning. Use simple, encouraging explanations. If it is already correct, use an empty issues list and say so in summary.'''
    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=api_key)
        config = types.GenerateContentConfig(response_mime_type="application/json")
        try:
            response = client.models.generate_content(model=model_name, contents=prompt, config=config)
        except Exception as exc:
            status_code = getattr(exc, "status_code", None) or getattr(exc, "status", None)
            if status_code is None and hasattr(exc, "last_attempt"):
                status_code = getattr(exc.last_attempt.exception(), "status_code", None)
            if status_code not in (429, 404, "RESOURCE_EXHAUSTED", "NOT_FOUND") or model_name == FALLBACK_MODEL_NAME:
                raise
            app.logger.warning(
                "Gemini model %s returned status %s; retrying with fallback model %s",
                model_name,
                status_code,
                FALLBACK_MODEL_NAME,
            )
            response = client.models.generate_content(model=FALLBACK_MODEL_NAME, contents=prompt, config=config)
        result = json.loads(response.text)
        if not isinstance(result, dict) or "corrected" not in result:
            raise ValueError("Unexpected Gemini response")
        return jsonify({"transcript": transcript, "feedback": result})
    except Exception:
        app.logger.exception("Gemini feedback failed")
        return error("Grammar feedback is unavailable right now. Please try again shortly.", 503)


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=int(os.getenv("PORT", "5000")))
