"""Language Practice Room Flask application with Socket.IO and WebRTC."""

from __future__ import annotations

import io
import base64
import hashlib
import hmac
import json
import os
import re
import time
import uuid
from collections import defaultdict
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

import speech_recognition as sr
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template, request
from flask_socketio import SocketIO, emit as socket_emit, join_room as join_socket_room
from supabase import Client, create_client
from werkzeug.utils import secure_filename

ENV_PATH = os.path.join(os.path.abspath(os.path.dirname(__file__)), ".env")
load_dotenv(ENV_PATH, override=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 12 * 1024 * 1024  # 12 MB audio limit
socketio_origins = [
    origin.strip()
    for origin in os.getenv("SOCKETIO_CORS_ORIGINS", "").split(",")
    if origin.strip()
]
socketio = SocketIO(
    app,
    async_mode="threading",
    cors_allowed_origins=socketio_origins or None,
)

MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
FALLBACK_MODEL_NAME = os.getenv("GEMINI_FALLBACK_MODEL", "gemini-3.5-flash-lite")
VIDEO_ROOMS_ENABLED = os.getenv("VIDEO_ROOMS_ENABLED", "false").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
SIGNAL_TTL_SECONDS = 15 * 60
MAX_VIDEO_ROOM_MEMBERS = 2
MAX_CHAT_ROOM_MEMBERS = 10
MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024
MAX_ROOM_HISTORY = 100
_rooms: dict[str, dict[str, object]] = defaultdict(
    lambda: {"peers": {}, "signals": [], "messages": [], "mode": None}
)
_rooms_lock = Lock()
_socket_peers: dict[str, dict[str, str]] = defaultdict(dict)
_socket_peers_lock = Lock()
_socket_identities: dict[str, tuple[str, str]] = {}
_supabase: Client | None = None


class RoomStorageConfigurationError(RuntimeError):
    pass


def supabase_client():
    global _supabase
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        if os.getenv("VERCEL") == "1":
            raise RoomStorageConfigurationError(
                "Room signaling is not configured for this deployment. Set "
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel, run "
                "supabase-schema.sql, and redeploy."
            )
        return None
    if _supabase is None:
        _supabase = create_client(url, key)
    return _supabase


@app.errorhandler(RoomStorageConfigurationError)
def handle_room_storage_configuration_error(exc: RoomStorageConfigurationError):
    app.logger.error("%s", exc)
    return error(str(exc), 503)


def supabase_room_table(client):
    return client.table(os.getenv("SUPABASE_ROOM_TABLE", "rooms"))


def supabase_rpc_missing(exc: Exception) -> bool:
    return getattr(exc, "code", None) == "PGRST202"


def supabase_room_messages_missing(exc: Exception) -> bool:
    return getattr(exc, "code", None) == "PGRST205"


def room_messages_schema_error(exc: Exception) -> RoomStorageConfigurationError:
    app.logger.error("Supabase room_messages table is unavailable: %s", exc)
    return RoomStorageConfigurationError(
        "Supabase is missing public.room_messages. Run supabase-schema.sql in "
        "the SQL Editor for the project configured by SUPABASE_URL, then retry."
    )


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
        room["messages"] = [
            message for message in room["messages"]
            if now - message.get("created", now) < SIGNAL_TTL_SECONDS
        ]
        if not room["peers"] and not room["signals"] and not room["messages"]:
            del _rooms[code]


def room_code(value: str) -> str:
    return re.sub(r"[^A-Z0-9-]", "", value.upper())[:32]


def room_member_limit(mode: str) -> int:
    return MAX_CHAT_ROOM_MEMBERS if mode == "chat" else MAX_VIDEO_ROOM_MEMBERS


def active_supabase_room_peers(table, code: str) -> list[dict[str, object]]:
    rows = table.select("id,peer_id,data").eq("room_code", code).execute().data or []
    peer_rows = [row for row in rows if row.get("data", {}).get("type") == "peer"]
    now = time.time()
    stale_ids = []
    active_rows = []
    for row in peer_rows:
        try:
            is_stale = now - float(row["data"].get("seen", 0)) >= SIGNAL_TTL_SECONDS
        except (TypeError, ValueError):
            is_stale = True
        if is_stale:
            stale_ids.append(row["id"])
        else:
            active_rows.append(row)
    if stale_ids:
        table.delete().in_("id", stale_ids).execute()
    return active_rows


def room_peer(code: str, peer_id: str) -> dict[str, object] | None:
    client = supabase_client()
    if client:
        rows = active_supabase_room_peers(supabase_room_table(client), code)
        peer = next((row for row in rows if row.get("peer_id") == peer_id), None)
        return peer.get("data") if peer else None
    with _rooms_lock:
        clean_expired_rooms()
        room = _rooms.get(code)
        return room["peers"].get(peer_id) if room else None


def room_has_peer(code: str, peer_id: str) -> bool:
    return room_peer(code, peer_id) is not None


def socket_peer_room(code: str, peer_id: str) -> str:
    return f"signal:{code}:{peer_id}"


def socket_room(code: str) -> str:
    return f"room:{code}"


def realtime_topic(code: str) -> str:
    return f"room:{code}"


def sign_realtime_token(code: str, peer_id: str) -> str:
    secret = os.getenv("SUPABASE_JWT_SECRET", "")
    if not secret:
        raise RoomStorageConfigurationError(
            "Set SUPABASE_JWT_SECRET to enable authenticated room broadcasts."
        )
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    claims = {
        "aud": "authenticated",
        "exp": now + 3600,
        "iat": now,
        "role": "authenticated",
        "room_code": code,
        "sub": peer_id,
    }

    def encode(value: dict[str, object]) -> str:
        payload = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
        return base64.urlsafe_b64encode(payload).rstrip(b"=").decode()

    unsigned_token = f"{encode(header)}.{encode(claims)}"
    signature = hmac.new(
        secret.encode(), unsigned_token.encode(), hashlib.sha256
    ).digest()
    return f"{unsigned_token}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"


def publish_realtime_event(code: str, event: str, payload: dict[str, object]) -> None:
    client = supabase_client()
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not client or not service_key:
        if os.getenv("VERCEL") == "1":
            raise RoomStorageConfigurationError(
                "Supabase room storage and realtime are required on Vercel."
            )
        return

    topic = quote(realtime_topic(code), safe="")
    event_name = quote(event, safe="")
    url = (
        f"{os.getenv('SUPABASE_URL', '').rstrip('/')}"
        f"/realtime/v1/api/broadcast/{topic}/events/{event_name}?private=true"
    )
    body = json.dumps(payload).encode()
    req = Request(
        url,
        data=body,
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(req, timeout=5) as response:
            if response.status >= 300:
                raise RuntimeError(f"Supabase Realtime returned HTTP {response.status}.")
    except (HTTPError, URLError, TimeoutError, RuntimeError) as exc:
        app.logger.error("Could not publish room event to Supabase Realtime: %s", exc)
        raise RoomStorageConfigurationError(
            "Room realtime is temporarily unavailable. Please reconnect and retry."
        ) from exc


def room_peers(code: str) -> list[dict[str, str]]:
    client = supabase_client()
    if client:
        rows = active_supabase_room_peers(supabase_room_table(client), code)
        return [
            {"id": str(row["peer_id"]), "name": str(row["data"].get("name", "Guest"))}
            for row in rows
        ]
    with _rooms_lock:
        clean_expired_rooms()
        room = _rooms.get(code)
        return [
            {"id": peer_id, "name": str(peer.get("name", "Guest"))}
            for peer_id, peer in room["peers"].items()
        ] if room else []


def room_message_history(code: str) -> list[dict[str, object]]:
    client = supabase_client()
    if client:
        try:
            rows = (
                client.table("room_messages")
                .select("payload")
                .eq("room_code", code)
                .order("created_at", desc=True)
                .limit(MAX_ROOM_HISTORY)
                .execute()
                .data
                or []
            )
        except Exception as exc:
            if supabase_room_messages_missing(exc):
                raise room_messages_schema_error(exc) from exc
            raise
        return [row["payload"] for row in reversed(rows)]
    with _rooms_lock:
        clean_expired_rooms()
        room = _rooms.get(code)
        return list(room["messages"][-MAX_ROOM_HISTORY:]) if room else []


def store_room_message(code: str, peer_id: str, message: dict[str, object]) -> None:
    client = supabase_client()
    if client:
        try:
            client.table("room_messages").upsert(
                {
                    "event_id": message["id"],
                    "room_code": code,
                    "sender_id": peer_id,
                    "payload": message,
                },
                on_conflict="event_id",
                ignore_duplicates=True,
            ).execute()
        except Exception as exc:
            if supabase_room_messages_missing(exc):
                raise room_messages_schema_error(exc) from exc
            raise
        return
    with _rooms_lock:
        room = _rooms.get(code)
        if not room or peer_id not in room["peers"]:
            raise RoomStorageConfigurationError("Join the room before sending messages.")
        room["messages"].append(message | {"created": time.time()})


def build_room_chat_message(
    code: str,
    peer_id: str,
    member: dict[str, object],
    submitted: dict[str, object],
) -> tuple[dict[str, object] | None, str | None]:
    event_type = submitted.get("type")
    message_id = str(submitted.get("id") or uuid.uuid4())[:80]
    event: dict[str, object] = {
        "id": message_id,
        "type": event_type,
        "senderId": peer_id,
        "sender": str(member.get("name", "Guest")),
    }
    if event_type == "chat-text":
        text = submitted.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > 12000:
            return None, "Chat messages must contain 1 to 12,000 characters."
        event["text"] = text
    elif event_type == "chat-code":
        code_text = submitted.get("code")
        if not isinstance(code_text, str) or not code_text.strip() or len(code_text) > 12000:
            return None, "Code messages must contain 1 to 12,000 characters."
        event["code"] = code_text
    elif event_type == "chat-file":
        path = str(submitted.get("path", ""))
        name = str(submitted.get("name", ""))[:255]
        size = submitted.get("size")
        if (
            not path.startswith(f"{code}/")
            or ".." in path.split("/")
            or not name
            or not isinstance(size, int)
            or isinstance(size, bool)
            or size <= 0
            or size > MAX_CHAT_FILE_BYTES
        ):
            return None, "Invalid room file attachment."
        event.update({"path": path, "name": name, "size": size})
    else:
        return None, "Unsupported room chat message."
    return event, None


def remove_room_message(code: str, peer_id: str, event_id: str) -> bool:
    client = supabase_client()
    if client:
        existing = (
            client.table("room_messages")
            .select("event_id")
            .eq("room_code", code)
            .eq("sender_id", peer_id)
            .eq("event_id", event_id)
            .limit(1)
            .execute()
        )
        if not existing.data:
            return False
        (
            client.table("room_messages")
            .delete()
            .eq("room_code", code)
            .eq("sender_id", peer_id)
            .eq("event_id", event_id)
            .execute()
        )
        return True
    with _rooms_lock:
        room = _rooms.get(code)
        if not room:
            return False
        original_count = len(room["messages"])
        room["messages"] = [
            message for message in room["messages"]
            if not (message.get("id") == event_id and message.get("senderId") == peer_id)
        ]
        return len(room["messages"]) != original_count


def store_room_signal(
    code: str,
    sender: str,
    recipient: str,
    signal_item: dict[str, object],
) -> bool:
    client = supabase_client()
    if client:
        if os.getenv("SUPABASE_ROOM_TABLE", "rooms") == "rooms":
            try:
                accepted = client.rpc("send_room_signal", {
                    "p_room_code": code,
                    "p_sender": sender,
                    "p_recipient": recipient,
                    "p_message": signal_item["message"],
                    "p_signal_id": signal_item["id"],
                    "p_created": signal_item["created"],
                }).execute().data
            except Exception as exc:
                if not supabase_rpc_missing(exc):
                    raise
                app.logger.warning("send_room_signal RPC is unavailable; using table-based signaling")
            else:
                return bool(accepted)

        table = supabase_room_table(client)
        rows = table.select("peer_id,data").eq("room_code", code).execute().data or []
        peers = {
            row["peer_id"]
            for row in rows
            if row.get("data", {}).get("type") == "peer"
        }
        if sender not in peers or recipient not in peers:
            return False
        table.insert({
            "room_code": code,
            "peer_id": recipient,
            "data": {
                "type": "signal",
                "id": signal_item["id"],
                "from": sender,
                "to": recipient,
                "message": signal_item["message"],
                "created": signal_item["created"],
            },
        }).execute()
        return True

    with _rooms_lock:
        room = _rooms.get(code)
        if not room or sender not in room["peers"] or recipient not in room["peers"]:
            return False
        room["peers"][sender]["seen"] = time.time()
        room["signals"].append(signal_item)
        return True


def create_upload_path(code: str, filename: str) -> str:
    clean_name = secure_filename(filename)[:180] or "attachment"
    return f"{code}/{uuid.uuid4().hex}-{clean_name}"


def notify_room_peer_left(code: str, peer_id: str, skip_sid: str | None = None) -> None:
    notification = {"peerId": peer_id}
    socketio.emit(
        "room:peer-left",
        notification,
        to=socket_room(code),
        skip_sid=skip_sid,
    )
    publish_realtime_event(code, "room-peer-left", notification)


def remove_room_member(code: str, peer_id: str, skip_sid: str | None = None) -> bool:
    if not code or not peer_id:
        return False
    was_member = room_has_peer(code, peer_id)
    client = supabase_client()
    if client:
        table = supabase_room_table(client)
        rows = table.select("id,peer_id,data").eq("room_code", code).execute().data or []
        ids = [
            row["id"]
            for row in rows
            if row["peer_id"] == peer_id
            or row.get("data", {}).get("from") == peer_id
            or row.get("data", {}).get("to") == peer_id
        ]
        if ids:
            table.delete().in_("id", ids).execute()
    else:
        with _rooms_lock:
            room = _rooms.get(code)
            if room:
                room["peers"].pop(peer_id, None)
                room["signals"] = [
                    item for item in room["signals"]
                    if item["from"] != peer_id and item["to"] != peer_id
                ]

    with _socket_peers_lock:
        sid = _socket_peers.get(code, {}).pop(peer_id, None)
        if sid:
            _socket_identities.pop(sid, None)
    if was_member:
        notify_room_peer_left(code, peer_id, skip_sid)
    return was_member


@socketio.on("room:join")
def join_signaling_room(data):
    if not isinstance(data, dict):
        return {"ok": False, "error": "Invalid room signaling request."}
    code = room_code(str(data.get("room", "")))
    peer_id = str(data.get("peerId", ""))[:80]
    peer = room_peer(code, peer_id) if code and peer_id else None
    if not peer:
        return {"ok": False, "error": "Join the room before connecting to signaling."}

    sid = request.sid
    with _socket_peers_lock:
        already_connected = peer_id in _socket_peers.get(code, {})
        _socket_peers[code][peer_id] = sid
        _socket_identities[sid] = (code, peer_id)
    join_socket_room(socket_room(code))
    join_socket_room(socket_peer_room(code, peer_id))
    if not already_connected:
        notification = {
            "peer": {"id": peer_id, "name": str(peer.get("name", "Guest"))}
        }
        socket_emit(
            "room:peer-joined",
            notification,
            to=socket_room(code),
            skip_sid=sid,
        )
        publish_realtime_event(code, "room-peer-joined", notification)
    try:
        messages = room_message_history(code)
    except RoomStorageConfigurationError as exc:
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "peers": [item for item in room_peers(code) if item["id"] != peer_id],
        "messages": messages,
    }


@socketio.on("room:leave")
def leave_signaling_room(data):
    if not isinstance(data, dict):
        return {"ok": False, "error": "Invalid room leave request."}
    code = room_code(str(data.get("room", "")))
    peer_id = str(data.get("peerId", ""))[:80]
    if _socket_identities.get(request.sid) != (code, peer_id):
        return {"ok": False, "error": "This connection is not a room member."}
    remove_room_member(code, peer_id, request.sid)
    return {"ok": True}


@socketio.on("room:signal")
def relay_socket_signal(data):
    if not isinstance(data, dict):
        return {"ok": False, "error": "Invalid signaling message."}
    code = room_code(str(data.get("room", "")))
    sender = str(data.get("from", ""))[:80]
    recipient = str(data.get("to", ""))[:80]
    message = data.get("message")
    identity = _socket_identities.get(request.sid)
    if (
        not code
        or identity != (code, sender)
        or not recipient
        or not isinstance(message, dict)
        or message.get("type") not in {"offer", "answer", "candidate"}
    ):
        return {"ok": False, "error": "Invalid signaling message."}

    signal_item = {
        "id": str(message.get("signalId") or uuid.uuid4().hex),
        "from": sender,
        "to": recipient,
        "message": message,
        "created": time.time(),
    }
    if not store_room_signal(code, sender, recipient, signal_item):
        return {"ok": False, "fallback": True}

    socket_emit(
        "room:signal",
        {"id": signal_item["id"], "from": sender, "to": recipient, "message": message},
        to=socket_peer_room(code, recipient),
    )
    publish_realtime_event(
        code,
        "room-signal",
        {"id": signal_item["id"], "from": sender, "to": recipient, "message": message},
    )
    return {"ok": True}


@socketio.on("room:event")
def handle_socket_room_event(data):
    if not isinstance(data, dict) or not isinstance(data.get("message"), dict):
        return {"ok": False, "error": "Invalid room event."}
    code = room_code(str(data.get("room", "")))
    peer_id = str(data.get("peerId", ""))[:80]
    if _socket_identities.get(request.sid) != (code, peer_id):
        return {"ok": False, "error": "Join the room before sending events."}
    member = room_peer(code, peer_id)
    if not member:
        return {"ok": False, "error": "Room session expired. Join again."}

    submitted = data["message"]
    event_type = submitted.get("type")
    if event_type in {"chat-text", "chat-code", "chat-file"}:
        event, validation_error = build_room_chat_message(
            code, peer_id, member, submitted
        )
        if validation_error or event is None:
            return {"ok": False, "error": validation_error or "Invalid room chat message."}
        try:
            store_room_message(code, peer_id, event)
            socket_emit("room:event", event, to=socket_room(code), skip_sid=request.sid)
            publish_realtime_event(code, "room-event", event)
        except RoomStorageConfigurationError as exc:
            app.logger.error("Room event delivery failed: %s", exc)
            return {"ok": False, "error": str(exc)}
        return {"ok": True}

    message_id = str(submitted.get("id") or uuid.uuid4())
    event: dict[str, object] = {
        "id": message_id[:80],
        "type": event_type,
        "senderId": peer_id,
        "sender": str(member.get("name", "Guest")),
    }
    if event_type == "chat-delete":
        target_id = str(submitted.get("targetId", ""))[:80]
        if not target_id or not remove_room_message(code, peer_id, target_id):
            return {"ok": False, "error": "You can only delete your own messages."}
        event["targetId"] = target_id
    elif event_type == "camera-status" and isinstance(submitted.get("cameraOn"), bool):
        event["cameraOn"] = submitted["cameraOn"]
    else:
        return {"ok": False, "error": "Unsupported room event."}

    try:
        socket_emit("room:event", event, to=socket_room(code), skip_sid=request.sid)
        publish_realtime_event(code, "room-event", event)
    except RoomStorageConfigurationError as exc:
        app.logger.error("Room event delivery failed: %s", exc)
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


@socketio.on("disconnect")
def disconnect_signaling_peer():
    identity = _socket_identities.pop(request.sid, None)
    if not identity:
        return
    code, peer_id = identity
    with _socket_peers_lock:
        room_peers = _socket_peers.get(code)
        if room_peers and room_peers.get(peer_id) == request.sid:
            del room_peers[peer_id]
            if not room_peers:
                _socket_peers.pop(code, None)


@app.get("/")
def index():
    return render_template(
        "index.html",
        topics=TOPICS,
        video_rooms_enabled=VIDEO_ROOMS_ENABLED,
    )


@app.get("/create")
def create_room_page():
    mode = "chat" if request.args.get("mode") == "chat" else "video"
    return render_template(
        "create.html",
        topics=TOPICS,
        room_mode=mode,
        video_rooms_enabled=VIDEO_ROOMS_ENABLED,
    )


@app.get("/join")
def join_room_page():
    code = request.args.get("code", "")
    return render_template("join.html", prefill_code=code, topics=TOPICS)


@app.get("/room/<room_code_val>")
def room_page(room_code_val: str):
    code = room_code(room_code_val)
    mode = "chat" if request.args.get("mode") == "chat" else "video"
    return render_template(
        "room.html",
        room_code=code,
        room_mode=mode,
        topics=TOPICS,
        ice_servers=webrtc_ice_servers(),
        socket_signaling_enabled=True,
        supabase_url=os.getenv("SUPABASE_URL", ""),
        supabase_anon_key=os.getenv("SUPABASE_ANON_KEY", ""),
        supabase_storage_bucket=os.getenv("SUPABASE_STORAGE_BUCKET", "chat-files"),
    )


@app.get("/room")
def room_query():
    code = room_code(request.args.get("code", ""))
    if not code:
        from flask import redirect, url_for
        return redirect(url_for("join_room_page"))
    mode = "chat" if request.args.get("mode") == "chat" else "video"
    return render_template(
        "room.html",
        room_code=code,
        room_mode=mode,
        topics=TOPICS,
        ice_servers=webrtc_ice_servers(),
        socket_signaling_enabled=True,
        supabase_url=os.getenv("SUPABASE_URL", ""),
        supabase_anon_key=os.getenv("SUPABASE_ANON_KEY", ""),
        supabase_storage_bucket=os.getenv("SUPABASE_STORAGE_BUCKET", "chat-files"),
    )


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
        peer_rows = active_supabase_room_peers(supabase_room_table(client), code)
        count = len(peer_rows)
        mode = peer_rows[0].get("data", {}).get("mode", "video") if peer_rows else "video"
    else:
        with _rooms_lock:
            clean_expired_rooms()
            room = _rooms.get(code)
            count = len(room["peers"]) if room else 0
            mode = room.get("mode", "video") if room else "video"
    max_members = room_member_limit(mode)
    return jsonify({"room": code, "peerCount": count, "exists": count > 0, "maxMembers": max_members, "available": count < max_members, "mode": mode})


@app.get("/api/rooms/realtime-token")
def room_realtime_token():
    code = room_code(request.args.get("room", ""))
    peer_id = request.args.get("peerId", "")[:80]
    if not code or not peer_id or not room_has_peer(code, peer_id):
        return error("Join the room before connecting to realtime.", 403)
    if not os.getenv("SUPABASE_ANON_KEY"):
        return error("Set SUPABASE_ANON_KEY to enable shared room realtime.", 503)
    try:
        token = sign_realtime_token(code, peer_id)
    except RoomStorageConfigurationError as exc:
        return error(str(exc), 503)
    return jsonify({"token": token})


@app.post("/api/rooms/files/upload")
def create_room_file_upload():
    data = request.get_json(silent=True) or {}
    code = room_code(str(data.get("room", "")))
    peer_id = str(data.get("peerId", ""))[:80]
    filename = str(data.get("name", ""))[:255]
    size = data.get("size")
    if not code or not peer_id or not room_has_peer(code, peer_id):
        return error("Join the room before uploading files.", 403)
    if not filename or not isinstance(size, int) or size <= 0 or size > MAX_CHAT_FILE_BYTES:
        return error("Files must be between 1 byte and 10 MB.", 413)
    client = supabase_client()
    if not client:
        return error("Supabase Storage is not configured.", 503)
    path = create_upload_path(code, filename)
    signed_upload = client.storage.from_(os.getenv("SUPABASE_STORAGE_BUCKET", "chat-files")).create_signed_upload_url(path)
    return jsonify({"path": signed_upload["path"], "token": signed_upload["token"]})


@app.get("/api/rooms/files/download")
def download_room_file():
    code = room_code(request.args.get("room", ""))
    peer_id = request.args.get("peerId", "")[:80]
    path = request.args.get("path", "")
    if not code or not peer_id or not room_has_peer(code, peer_id):
        return error("Join the room before downloading files.", 403)
    if not path.startswith(f"{code}/") or ".." in path.split("/"):
        return error("Invalid room file path.")
    client = supabase_client()
    if not client:
        return error("Supabase Storage is not configured.", 503)
    signed_url = client.storage.from_(
        os.getenv("SUPABASE_STORAGE_BUCKET", "chat-files")
    ).create_signed_url(path, 300, {"download": True})
    return redirect(signed_url["signedURL"], code=302)


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
        peer_rows = active_supabase_room_peers(table, code)
        existing = next((row for row in peer_rows if row["peer_id"] == peer_id), None)
        if not peer_rows and not is_host:
            return error("Room not found. Check the room code and try again.", 404)
        mode = peer_rows[0].get("data", {}).get("mode", "video") if peer_rows else requested_mode
        max_members = room_member_limit(mode)
        if not existing and len(peer_rows) >= max_members:
            return error(f"This {mode} room already has {max_members} people.", 409)
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
            mode = room.get("mode") or requested_mode
            max_members = room_member_limit(mode)
            if peer_id not in peers and len(peers) >= max_members:
                return error(f"This {mode} room already has {max_members} people.", 409)
            if not peers:
                room["mode"] = mode
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
    signal_item = {
        "id": str(message.get("signalId") or uuid.uuid4().hex),
        "from": sender,
        "to": recipient,
        "message": message,
        "created": time.time(),
    }
    if not store_room_signal(code, sender, recipient, signal_item):
        return error("Join the room before signaling.", 404)
    packet = {
        "id": signal_item["id"],
        "from": sender,
        "to": recipient,
        "message": message,
    }
    socketio.emit("room:signal", packet, to=socket_peer_room(code, recipient))
    try:
        publish_realtime_event(code, "room-signal", packet)
    except RoomStorageConfigurationError as exc:
        return error(str(exc), 503)
    return jsonify({"ok": True})


@app.post("/api/rooms/chat")
def post_room_chat_message():
    data = request.get_json(silent=True) or {}
    code = room_code(str(data.get("room", "")))
    peer_id = str(data.get("peerId", ""))[:80]
    submitted = data.get("message")
    if not code or not peer_id or not isinstance(submitted, dict):
        return error("Invalid room chat message.")
    member = room_peer(code, peer_id)
    if not member:
        return error("Join the room before sending messages.", 403)
    event, validation_error = build_room_chat_message(
        code, peer_id, member, submitted
    )
    if validation_error or event is None:
        return error(validation_error or "Invalid room chat message.")
    try:
        store_room_message(code, peer_id, event)
    except RoomStorageConfigurationError as exc:
        return error(str(exc), 503)
    try:
        publish_realtime_event(code, "room-event", event)
    except RoomStorageConfigurationError:
        app.logger.warning(
            "Room chat message saved; recipients will receive it through room polling."
        )
    return jsonify({"ok": True})


@app.get("/api/rooms/poll")
def poll_room():
    code = room_code(request.args.get("room", ""))
    peer_id = request.args.get("peerId", "")[:80]
    if not code or not peer_id:
        return error("A room and peer ID are required.")
    client = supabase_client()
    if client:
        if os.getenv("SUPABASE_ROOM_TABLE", "rooms") == "rooms":
            try:
                result = client.rpc("poll_room", {
                    "p_room_code": code,
                    "p_peer_id": peer_id,
                }).execute().data
            except Exception as exc:
                if not supabase_rpc_missing(exc):
                    raise
                app.logger.warning("poll_room RPC is unavailable; using table-based polling")
            else:
                if result is None:
                    return error("Room session expired. Join again.", 404)
                result["messages"] = room_message_history(code)
                return jsonify(result)
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
    return jsonify({
        "signals": received,
        "peers": peers,
        "messages": room_message_history(code),
    })


@app.post("/api/rooms/leave")
def leave_room():
    data = request.get_json(silent=True) or {}
    code, peer_id = room_code(str(data.get("room", ""))), str(data.get("peerId", ""))[:80]
    try:
        remove_room_member(code, peer_id)
    except RoomStorageConfigurationError as exc:
        app.logger.error("Could not publish room leave event: %s", exc)
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
    socketio.run(app, debug=True, host="0.0.0.0", port=int(os.getenv("PORT", "5000")))
