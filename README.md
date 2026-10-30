# Xynoz Language Practice

A language-practice room with peer-to-peer video, audio, and screen sharing over WebRTC; Socket.IO for room events, chat, and WebRTC signaling; Supabase Postgres and Realtime for shared room state and cross-instance delivery; and private Supabase Storage for file sharing. Speech transcription uses Python `SpeechRecognition`, and grammar feedback is generated server-side with Gemini.

## Run locally

1. Create and activate a virtual environment, then run `pip install -r requirements.txt`.
2. Copy `.env.example` to `.env`, add your Gemini API key, and replace the Supabase placeholders with your project values below.
3. Run [supabase-schema.sql](supabase-schema.sql) in the Supabase SQL Editor.
4. Run `python app.py`, then visit `http://localhost:5000`.
5. Two users enter the same room code and choose **Join room**. Share a topic, speak, then use **Record practice speech** and **Stop & analyze**.

## Deploy to Vercel

Import the repository (or run `vercel` in the project), then set `GEMINI_API_KEY` and optionally `GEMINI_MODEL=gemini-2.5-flash` in **Project Settings → Environment Variables**. The app falls back to `gemini-3.5-flash-lite` if the primary model is unavailable or quota-limited. Redeploy after saving the variable. Do not upload `.env`.

`vercel.json` enables Fluid Compute and routes Socket.IO WebSocket upgrades to the Flask Python function. Vercel supports WebSockets for Python WSGI applications, including Flask. The client uses WebSocket transport directly (not Socket.IO's default HTTP long-polling), reconnects automatically, rejoins the room, and restores recent chat from Supabase. If Socket.IO cannot connect, chat remains available through an HTTP send endpoint and room polling; Supabase Realtime private broadcasts provide faster cross-instance delivery when available. Postgres stores room membership and chat history. Vercel closes WebSockets when the function reaches its maximum duration: the Fluid Compute default is 300 seconds, after which clients reconnect and restore room state. Calls keep their media peer-to-peer with WebRTC; no audio or video is relayed through Socket.IO or Supabase. The default ICE configuration uses Google's public STUN server; networks that block direct peer connections may require a TURN server.

Run [supabase-schema.sql](supabase-schema.sql) in the Supabase SQL Editor (and rerun it after schema updates). It creates the room/message tables, private `chat-files` bucket, Realtime room authorization policy, and signaling RPCs. Add these environment variables locally and in **Vercel Project Settings → Environment Variables**:
- `SUPABASE_URL`: your Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service-role/secret key. Server-side only; never expose it to the browser.
- `SUPABASE_ANON_KEY`: Supabase anon/publishable key. This public key is used by the browser for authenticated Realtime subscriptions and signed Storage uploads.
- `SUPABASE_JWT_SECRET`: the Supabase project's JWT signing secret. Server-side only; used to mint one-hour, room-scoped Realtime tokens.
- `SUPABASE_ROOM_TABLE`: `rooms`.
- `SUPABASE_STORAGE_BUCKET`: `chat-files` (created as a private bucket by the SQL schema).
- `SOCKETIO_CORS_ORIGINS`: optional comma-separated allowed origins for cross-origin Socket.IO clients. Same-origin is the default.

The Supabase JWT secret is available in the project's API/JWT settings. Keep both it and the service-role key private. After setting the variables and running the SQL, redeploy to Vercel. File attachments (up to 10 MB) are uploaded directly to the private Storage bucket using short-lived signed upload tokens; downloads use short-lived signed URLs after the server verifies room membership.

If room polling reports that `public.room_messages` is missing, run the schema script in the Supabase project matching `SUPABASE_URL`; the local SQL file does not update the hosted database automatically.

## Speech recognition

The browser captures microphone audio and sends WAV audio to Python `SpeechRecognition` for transcription:
- Browser recording and WAV audio transcription via `/api/transcribe`.

## API overview

- `POST /api/transcribe` accepts a WAV upload in `audio` and returns its transcript via Python `SpeechRecognition`.
- `POST /api/grammar` accepts `{"transcript":"..."}` and returns correction JSON generated server-side.
- `/api/rooms/*` provides room creation/joining, presence heartbeats, reconnect authorization, and signed file URLs. Socket.IO handles chat, room join/leave notifications, and WebRTC offer/answer/ICE signaling. Supabase Realtime private broadcasts bridge Vercel function instances, while Postgres retains recent chat for reconnection. In chat, including video practice rooms, use the `</>` button to compose multiline code blocks; Enter inserts a newline and Ctrl+Enter sends the code. Video calls prewarm ICE candidates and use bundled media tracks; chat-only rooms do not enable the video-specific ICE pool.

Vercel references: [Python WebSockets](https://vercel.com/docs/functions/websockets#python-frameworks), [Fluid Compute](https://vercel.com/docs/fluid-compute), and [function duration limits](https://vercel.com/docs/functions/limitations#max-duration).
