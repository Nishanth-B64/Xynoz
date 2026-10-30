/* Xynoz - Real-time WebRTC, Device Previews, Speech-to-Text & AI Coach */

const $ = (id) => document.getElementById(id);
const DISPLAY_NAME_STORAGE_KEY = 'xynoz_name';
const LEGACY_DISPLAY_NAME_STORAGE_KEY = 'speakspace_name';
const ROOM_PEER_STORAGE_PREFIX = 'xynoz_room_peer_';

function getSavedDisplayName() {
  const savedName = localStorage.getItem(DISPLAY_NAME_STORAGE_KEY);
  if (savedName) return savedName;
  const legacyName = localStorage.getItem(LEGACY_DISPLAY_NAME_STORAGE_KEY) || '';
  if (legacyName) localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, legacyName);
  return legacyName;
}

function getRoomPeerId(room) {
  const key = `${ROOM_PEER_STORAGE_PREFIX}${room}`;
  let peerId = sessionStorage.getItem(key);
  if (!peerId) {
    peerId = crypto.randomUUID();
    sessionStorage.setItem(key, peerId);
  }
  return peerId;
}

// Toast notification helper
function showToast(message, icon = '✦') {
  const toast = $('toast');
  if (!toast) return;
  const toastIcon = $('toastIcon');
  const toastMsg = $('toastMsg');
  if (toastIcon) toastIcon.textContent = icon;
  if (toastMsg) toastMsg.textContent = message;
  toast.style.display = 'flex';
  clearTimeout(window._toastTimeout);
  window._toastTimeout = setTimeout(() => {
    toast.style.display = 'none';
  }, 3200);
}

// Random Room Code Generator
const CODE_PREFIXES = ['SPEAK', 'TALK', 'FLUENT', 'CHAT', 'CONVO', 'PRACTICE', 'ECHO', 'VOICE'];
const CODE_SUFFIXES = ['BREEZE', 'STARS', 'RIVER', 'COAST', 'SPARK', 'WAVE', 'EAGLE', 'HARBOR'];
function generateRandomRoomCode() {
  const p = CODE_PREFIXES[Math.floor(Math.random() * CODE_PREFIXES.length)];
  const s = CODE_SUFFIXES[Math.floor(Math.random() * CODE_SUFFIXES.length)];
  const num = Math.floor(10 + Math.random() * 90);
  return `${p}-${s}-${num}`;
}

// API helper
async function api(url, options = {}) {
  const res = await fetch(url, options);
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const fallback = res.status >= 500
      ? `Server error (${res.status}). Check the room service configuration and server logs.`
      : `Request failed (HTTP ${res.status}).`;
    throw new Error(body?.error || fallback);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`Invalid server response (HTTP ${res.status}).`);
  }
  return body;
}

// Device Preview Helper (for create.html and join.html)
let previewStream = null;
let previewAudioCtx = null;
let previewAnalyser = null;
let previewAnimFrame = null;

async function requestMicrophoneStream() {
  return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
}

async function startDevicePreview(videoEl, fallbackEl, meterFillEl, statusTextEl) {
  try {
    if (statusTextEl) statusTextEl.textContent = 'Requesting camera & mic…';
    if (previewStream) {
      previewStream.getTracks().forEach(t => t.stop());
    }
    previewStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: { echoCancellation: true, noiseSuppression: true }
    });

    if (videoEl) {
      videoEl.srcObject = previewStream;
      videoEl.style.display = 'block';
    }
    if (fallbackEl) fallbackEl.style.display = 'none';
    if (statusTextEl) statusTextEl.textContent = 'Devices connected';

    // Audio meter visualizer
    if (meterFillEl) {
      previewAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = previewAudioCtx.createMediaStreamSource(previewStream);
      previewAnalyser = previewAudioCtx.createAnalyser();
      previewAnalyser.fftSize = 64;
      source.connect(previewAnalyser);
      const dataArray = new Uint8Array(previewAnalyser.frequencyBinCount);

      function updateMeter() {
        if (!previewAnalyser) return;
        previewAnalyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        const pct = Math.min(100, Math.round((avg / 128) * 100));
        meterFillEl.style.width = `${pct}%`;
        previewAnimFrame = requestAnimationFrame(updateMeter);
      }
      updateMeter();
    }
    showToast('Camera and microphone ready!', '✅');
  } catch (err) {
    if (statusTextEl) statusTextEl.textContent = 'Permission denied or device missing';
    showToast('Could not access camera/mic. Check browser permissions.', '⚠️');
    console.warn('Device preview error:', err);
  }
}

async function testDevice(kind) {
  const cameraBtn = $('testCameraBtn');
  const micBtn = $('testMicBtn');
  const statusText = $('deviceStatusText');
  const constraints = kind === 'camera'
    ? { video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }
    : { video: false, audio: { echoCancellation: true, noiseSuppression: true } };

  try {
    if (statusText) statusText.textContent = `Testing ${kind}…`;
    const stream = kind === 'mic'
      ? await requestMicrophoneStream()
      : await navigator.mediaDevices.getUserMedia(constraints);
    const oldTracks = (previewStream?.getTracks() || []).filter(track => track.kind === (kind === 'camera' ? 'video' : 'audio'));
    oldTracks.forEach(track => track.stop());
    if (!previewStream) previewStream = new MediaStream();
    previewStream.addTrack(stream.getTracks()[0]);

    if (kind === 'camera') {
      const video = $('previewVideo');
      if (video) {
        video.srcObject = previewStream;
        video.style.display = 'block';
      }
      if ($('previewFallback')) $('previewFallback').style.display = 'none';
      if (cameraBtn) cameraBtn.classList.add('active');
    } else {
      previewAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = previewAudioCtx.createMediaStreamSource(new MediaStream([stream.getAudioTracks()[0]]));
      previewAnalyser = previewAudioCtx.createAnalyser();
      previewAnalyser.fftSize = 64;
      source.connect(previewAnalyser);
      const dataArray = new Uint8Array(previewAnalyser.frequencyBinCount);
      const updateMeter = () => {
        if (!previewAnalyser) return;
        previewAnalyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
        if ($('audioMeterFill')) $('audioMeterFill').style.width = `${Math.min(100, Math.round((average / 128) * 100))}%`;
        previewAnimFrame = requestAnimationFrame(updateMeter);
      };
      updateMeter();
      if (micBtn) micBtn.classList.add('active');
    }
    if (statusText) statusText.textContent = `${kind === 'camera' ? 'Camera' : 'Microphone'} test passed`;
    showToast(`${kind === 'camera' ? 'Camera' : 'Microphone'} is ready`, '✅');
  } catch (err) {
    if (statusText) statusText.textContent = `${kind === 'camera' ? 'Camera' : 'Microphone'} test failed`;
    showToast(`Could not access the ${kind}. Check browser permissions.`, '⚠️');
    console.warn(`${kind} test error:`, err);
  }
}

function cleanupDevicePreview() {
  if (previewAnimFrame) cancelAnimationFrame(previewAnimFrame);
  if (previewStream) {
    previewStream.getTracks().forEach(t => t.stop());
    previewStream = null;
  }
  if (previewAudioCtx && previewAudioCtx.state !== 'closed') {
    previewAudioCtx.close().catch(() => {});
  }
}

// --------------------------------------------------------------------------
// 1. Create Page Flow (create.html)
// --------------------------------------------------------------------------
function initCreatePage() {
  const hostNameInput = $('hostName');
  const roomCodeDisplay = $('roomCodeDisplay');
  const roomCodeHidden = $('roomCode');
  const randomizeBtn = $('randomizeCodeBtn');
  const copyCodeBtn = $('copyCodeBtn');
  const conversationFocus = $('conversationFocus');
  const customTopic = $('customTopic');

  // Prepopulate saved display name
  const savedName = getSavedDisplayName();
  if (hostNameInput) hostNameInput.value = savedName;

  // Generate initial room code
  const initialCode = generateRandomRoomCode();
  if (roomCodeDisplay) roomCodeDisplay.textContent = initialCode;
  if (roomCodeHidden) roomCodeHidden.value = initialCode;

  if (randomizeBtn) {
    randomizeBtn.addEventListener('click', () => {
      const newCode = generateRandomRoomCode();
      if (roomCodeDisplay) roomCodeDisplay.textContent = newCode;
      if (roomCodeHidden) roomCodeHidden.value = newCode;
    });
  }

  if (copyCodeBtn) {
    copyCodeBtn.addEventListener('click', () => {
      const code = roomCodeHidden.value;
      navigator.clipboard.writeText(code).then(() => {
        showToast(`Room code ${code} copied!`, '📋');
      });
    });
  }

  if (conversationFocus) conversationFocus.addEventListener('change', () => {
    if (customTopic) customTopic.style.display = conversationFocus.value === 'custom' ? 'block' : 'none';
  });
  if ($('testCameraBtn')) $('testCameraBtn').addEventListener('click', () => testDevice('camera'));
  if ($('testMicBtn')) $('testMicBtn').addEventListener('click', () => testDevice('mic'));
}

function launchRoom() {
  const name = $('hostName').value.trim() || 'Host';
  const code = $('roomCode').value.trim().toUpperCase();
  const mode = $('roomMode')?.value === 'chat' ? 'chat' : 'video';
  if (mode !== 'chat' && window.VIDEO_ROOMS_ENABLED !== true) return;
  if (code.length < 3) return alert('Room code must be at least 3 characters.');
  localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, name);
  cleanupDevicePreview();
  const selectedTopic = mode === 'chat' ? '' : $('conversationFocus')?.value === 'custom'
    ? $('customTopic')?.value.trim()
    : $('conversationFocus')?.value;
  const topicParam = selectedTopic ? `&topic=${encodeURIComponent(selectedTopic)}` : '';
  window.location.href = `/room/${encodeURIComponent(code)}?name=${encodeURIComponent(name)}${topicParam}&host=1&mode=${mode}`;
}

// --------------------------------------------------------------------------
// 2. Join Page Flow (join.html)
// --------------------------------------------------------------------------
function initJoinPage() {
  const nameInput = $('participantName');
  const codeInput = $('joinRoomCode');

  const savedName = getSavedDisplayName();
  if (nameInput && !nameInput.value) nameInput.value = savedName;

  // Auto-uppercase room code as user types
  if (codeInput) {
    codeInput.addEventListener('input', () => {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    });
  }

  if ($('testCameraBtn')) $('testCameraBtn').addEventListener('click', () => testDevice('camera'));
  if ($('testMicBtn')) $('testMicBtn').addEventListener('click', () => testDevice('mic'));
}

async function proceedToRoom() {
  const name = $('participantName').value.trim() || 'Guest';
  const code = $('joinRoomCode').value.trim().toUpperCase();
  if (code.length < 3) return alert('Please enter a valid room code with at least 3 characters.');
  const submitButton = $('submitJoinBtn');
  const errorEl = $('joinRoomError');
  if (errorEl) errorEl.textContent = '';
  if (submitButton) submitButton.disabled = true;
  try {
    const room = await api(`/api/rooms/status?room=${encodeURIComponent(code)}`);
    const roomExists = room.exists === true || Number(room.peerCount) > 0;
    if (!roomExists) throw new Error('Room not found. Check the room code and try again.');
    localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, name);
    cleanupDevicePreview();
    const modeParam = room.mode === 'chat' ? '&mode=chat' : '';
    window.location.href = `/room/${encodeURIComponent(code)}?name=${encodeURIComponent(name)}${modeParam}`;
  } catch (error) {
    if (errorEl) errorEl.textContent = error.message;
    else showToast(error.message, '⚠️');
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

// --------------------------------------------------------------------------
// 3. Live Practice Room Flow (room.html)
// --------------------------------------------------------------------------
const state = {
  peerId: '',
  room: '',
  name: 'You',
  partner: null,
  pc: null,
  connections: new Map(),
  peers: new Map(),
  screenTrack: null,
  stream: null,
  polling: null,
  pollInFlight: false,
  pollError: '',
  signalError: '',
  socket: null,
  socketReady: false,
  roomJoined: false,
  realtimeReady: false,
  handledSignals: new Set(),
  roomEventIds: new Set(),
  supabase: null,
  roomChannel: null,
  realtimeTokenRefresh: null,
  recording: false,
  recorderNode: null,
  audioContext: null,
  audioChunks: [],
  pendingCandidates: new Map(),
  topic: 0,
  customTopic: '',
  chatOnly: false,
  codeMode: false
};

const rtcConfig = {
  iceServers: Array.isArray(window.RTC_ICE_SERVERS) && window.RTC_ICE_SERVERS.length
    ? window.RTC_ICE_SERVERS
    : [{ urls: 'stun:stun.l.google.com:19302' }]
};
const CHAT_FILE_MAX_BYTES = 10 * 1024 * 1024;

function setCallStatus(text, connected = false) {
  const statusEl = $('callStatus');
  const textEl = $('callStatusText');
  if (!statusEl || !textEl) return;
  const dot = statusEl.querySelector('.status-dot');
  if (dot) dot.classList.toggle('active', connected);
  textEl.textContent = text;
}

function showTopic() {
  if (state.customTopic) {
    if ($('topicNumber')) $('topicNumber').textContent = '★';
    if ($('topicTitle')) $('topicTitle').textContent = state.customTopic;
    if ($('topicPrompt')) $('topicPrompt').textContent = `Discuss ${state.customTopic} together.`;
    return;
  }
  const topics = window.PRACTICE_TOPICS || [];
  const topic = topics[state.topic];
  if (!topic) return;
  if ($('topicNumber')) $('topicNumber').textContent = String(state.topic + 1).padStart(2, '0');
  if ($('topicTitle')) $('topicTitle').textContent = topic.title;
  if ($('topicPrompt')) $('topicPrompt').textContent = topic.prompt;
}

function setRemoteCameraState(peerId, cameraOn) {
  const video = document.querySelector(`#remote-video-${CSS.escape(peerId)}`);
  const fallback = document.querySelector(`#remote-fallback-${CSS.escape(peerId)}`);
  if (video) video.style.display = cameraOn ? 'block' : 'none';
  if (fallback) {
    fallback.querySelector('span:last-child').textContent = cameraOn ? 'Connecting…' : 'Camera off';
    fallback.style.display = cameraOn ? 'none' : 'flex';
  }
}

function sendCameraStatus(cameraOn) {
  broadcastChatMessage({ type: 'camera-status', id: crypto.randomUUID(), cameraOn });
}

function addLocalTracksToPeer(pc) {
  if (!state.stream) return;
  for (const track of state.stream.getTracks()) {
    if (!pc.getSenders().some(sender => sender.track === track)) {
      pc.addTrack(track, state.stream);
    }
  }
}

async function getMedia() {
  if (state.stream) return state.stream;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera and microphone access is not supported by this browser.');
  }

  const streams = [];
  const errors = [];
  try {
    streams.push(await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    }));
  } catch (error) {
    errors.push(error);
    console.warn('Camera permission failed:', error);
  }
  try {
    streams.push(await requestMicrophoneStream());
  } catch (error) {
    errors.push(error);
    console.warn('Microphone permission failed:', error);
  }

  const tracks = streams.flatMap(stream => stream.getTracks());
  if (!tracks.length) throw errors[0] || new Error('Could not access camera or microphone.');
  state.stream = new MediaStream(tracks);
  for (const pc of state.connections.values()) addLocalTracksToPeer(pc);
  if ($('localVideo')) {
    $('localVideo').srcObject = state.stream;
    $('localVideo').style.display = 'block';
  }
  if ($('localFallback')) $('localFallback').style.display = 'none';
  if ($('cameraBtn')) $('cameraBtn').disabled = false;
  if ($('micBtn')) $('micBtn').disabled = false;
  if ($('recordBtn')) $('recordBtn').disabled = false;
  return state.stream;
}

function clearChatEmptyState() {
  $('chatMessages')?.querySelector('.chat-empty')?.remove();
}

function createChatActions(message, text, own, isCode = false) {
  const actions = document.createElement('div');
  actions.className = 'chat-message-actions';
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'chat-action-btn';
  copyButton.textContent = isCode ? 'Copy code' : 'Copy';
  copyButton.title = isCode ? 'Copy code' : 'Copy message';
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(isCode ? 'Code copied.' : 'Message copied.', '📋');
    } catch (error) {
      showToast('Could not copy message.', '⚠️');
    }
  });
  actions.appendChild(copyButton);
  if (own) {
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'chat-action-btn chat-delete-btn';
    deleteButton.textContent = 'Delete';
    deleteButton.title = 'Delete message';
    deleteButton.addEventListener('click', async () => {
      const deleted = await broadcastChatMessage({
        type: 'chat-delete',
        id: crypto.randomUUID(),
        targetId: message.dataset.messageId
      });
      if (deleted) message.remove();
    });
    actions.appendChild(deleteButton);
  }
  return actions;
}

function addChatMessage(text, sender, own = false, messageId = crypto.randomUUID(), isCode = false) {
  const messages = $('chatMessages');
  if (!messages) return;
  clearChatEmptyState();
  const message = document.createElement('div');
  message.className = `chat-message${own ? ' own' : ''}`;
  message.dataset.messageId = messageId;
  const author = document.createElement('strong');
  author.textContent = own ? 'You' : sender;
  let content;
  if (isCode) {
    content = document.createElement('pre');
    content.className = 'chat-code-block';
    const code = document.createElement('code');
    code.textContent = text;
    content.appendChild(code);
  } else {
    content = document.createElement('span');
    content.textContent = text;
  }
  message.append(author, content, createChatActions(message, text, own, isCode));
  messages.appendChild(message);
  messages.scrollTop = messages.scrollHeight;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function addChatFileMessage(file, sender, own = false, messageId = crypto.randomUUID()) {
  const messages = $('chatMessages');
  if (!messages) return;
  clearChatEmptyState();
  const message = document.createElement('div');
  message.className = `chat-message${own ? ' own' : ''}`;
  message.dataset.messageId = messageId;
  const author = document.createElement('strong');
  author.textContent = own ? 'You' : sender;
  const link = document.createElement('a');
  link.className = 'chat-file-link';
  link.href = `/api/rooms/files/download?room=${encodeURIComponent(state.room)}&peerId=${encodeURIComponent(state.peerId)}&path=${encodeURIComponent(file.path)}`;
  link.download = file.name;
  link.textContent = `📎 ${file.name} (${formatFileSize(file.size)})`;
  message.append(author, link, createChatActions(message, file.name, own));
  messages.appendChild(message);
  messages.scrollTop = messages.scrollHeight;
}

function setChatControlsEnabled(enabled) {
  if ($('chatInput')) $('chatInput').disabled = !enabled;
  if ($('chatSendBtn')) $('chatSendBtn').disabled = !enabled;
  if ($('chatAttachBtn')) $('chatAttachBtn').disabled = !enabled || !state.supabase;
  if ($('chatCodeBtn')) $('chatCodeBtn').disabled = !enabled;
}

async function broadcastChatMessage(message) {
  if (state.socket?.connected && state.socketReady) {
    const { timeoutError, response } = await new Promise(resolve => {
      state.socket.timeout(5000).emit('room:event', {
        room: state.room,
        peerId: state.peerId,
        message
      }, (error, result) => resolve({ timeoutError: error, response: result }));
    });
    if (!timeoutError && response?.ok) return true;
    if (!timeoutError && response?.error) {
      console.warn('Room message delivery failed:', response.error);
    }
  }

  if (!state.roomJoined || !['chat-text', 'chat-code', 'chat-file'].includes(message.type)) {
    showToast('Live chat is reconnecting. Please try again shortly.', '⚠️');
    return false;
  }
  try {
    await api('/api/rooms/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room: state.room,
        peerId: state.peerId,
        message
      })
    });
    return true;
  } catch (error) {
    console.warn('Room chat fallback failed:', error.message);
    showToast(error.message || 'Room message could not be delivered.', '⚠️');
    return false;
  }
}

function rememberRoomEvent(id) {
  if (!id) return false;
  if (state.roomEventIds.has(id)) return true;
  state.roomEventIds.add(id);
  if (state.roomEventIds.size > 500) {
    state.roomEventIds.delete(state.roomEventIds.values().next().value);
  }
  return false;
}

function handleRoomEvent(message) {
  if (!message || typeof message !== 'object' || rememberRoomEvent(message.id)) return;
  if (message.type === 'chat-delete') {
    document.querySelector(`[data-message-id="${CSS.escape(message.targetId)}"]`)?.remove();
  } else if (message.type === 'camera-status') {
    setRemoteCameraState(message.senderId, message.cameraOn === true);
  } else if (message.type === 'chat-code' && typeof message.code === 'string') {
    addChatMessage(message.code, message.sender || 'Partner', message.senderId === state.peerId, message.id, true);
  } else if (message.type === 'chat-file') {
    addChatFileMessage(message, message.sender || 'Partner', message.senderId === state.peerId, message.id);
  } else if (message.type === 'chat-text' && typeof message.text === 'string') {
    addChatMessage(message.text, message.sender || 'Partner', message.senderId === state.peerId, message.id);
  }
}

function updateChatStatus() {
  const count = state.peers.size;
  if ($('chatStatus')) {
    $('chatStatus').textContent = state.socketReady
      ? `${count} participant${count === 1 ? '' : 's'} connected`
      : state.roomJoined
        ? state.realtimeReady
          ? 'Chat active · backup link'
          : 'Chat active · restoring live link'
        : 'Connecting…';
  }
  setChatControlsEnabled(state.roomJoined);
}

function handlePeerJoined(peer) {
  if (!peer || !peer.id || peer.id === state.peerId || state.peers.has(peer.id)) return;
  state.peers.set(peer.id, peer);
  createRemoteTile(peer);
  if (!state.chatOnly) {
    makePeerConnection(peer);
    if (shouldCreateOffer(peer)) offerPeer(peer).catch(error => {
      console.warn('Could not start WebRTC negotiation:', error);
    });
  }
  updateChatStatus();
}

function handlePeerLeft(peerId) {
  if (!peerId || peerId === state.peerId) return;
  removeRemotePeer(peerId);
  updateChatStatus();
}

async function startSupabaseRoomChannel() {
  const config = window.SUPABASE_CONFIG;
  if (!window.supabase?.createClient || !config?.url || !config.anonKey) {
    throw new Error('Supabase browser configuration is missing.');
  }
  const tokenData = await api(
    `/api/rooms/realtime-token?room=${encodeURIComponent(state.room)}&peerId=${encodeURIComponent(state.peerId)}`
  );
  const supabase = window.supabase.createClient(config.url, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  await supabase.realtime.setAuth(tokenData.token);
  const channel = supabase.channel(`room:${state.room}`, { config: { private: true } });
  channel
    .on('broadcast', { event: 'room-event' }, ({ payload }) => handleRoomEvent(payload))
    .on('broadcast', { event: 'room-signal' }, ({ payload }) => {
      if (payload?.to === state.peerId) {
        handleSignal(payload).catch(error => console.warn('Could not process room signal:', error));
      }
    })
    .on('broadcast', { event: 'room-peer-joined' }, ({ payload }) => handlePeerJoined(payload?.peer))
    .on('broadcast', { event: 'room-peer-left' }, ({ payload }) => handlePeerLeft(payload?.peerId))
    .subscribe(status => {
      state.realtimeReady = status === 'SUBSCRIBED';
      updateChatStatus();
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.error('Supabase room realtime subscription failed:', status);
      }
    });
  state.supabase = supabase;
  state.roomChannel = channel;
  updateChatStatus();
  state.realtimeTokenRefresh = setInterval(async () => {
    try {
      const refreshed = await api(
        `/api/rooms/realtime-token?room=${encodeURIComponent(state.room)}&peerId=${encodeURIComponent(state.peerId)}`
      );
      await supabase.realtime.setAuth(refreshed.token);
    } catch (error) {
      console.error('Could not refresh room realtime authorization:', error);
    }
  }, 45 * 60 * 1000);
}

async function sendChatMessage() {
  const input = $('chatInput');
  const value = input?.value || '';
  if (!value.trim() || !state.roomJoined) return;
  const text = state.codeMode ? value : value.trim();
  const id = crypto.randomUUID();
  const message = state.codeMode
    ? { type: 'chat-code', id, code: text }
    : { type: 'chat-text', id, text };
  if (await broadcastChatMessage(message)) {
    if (!rememberRoomEvent(id)) {
      addChatMessage(text, state.name, true, id, state.codeMode);
    }
    input.value = '';
    input.focus();
  }
}

function setChatCodeMode(enabled) {
  state.codeMode = enabled;
  const button = $('chatCodeBtn');
  const input = $('chatInput');
  if (button) {
    button.classList.toggle('active', enabled);
    button.setAttribute('aria-pressed', String(enabled));
    button.title = enabled ? 'Turn off code mode' : 'Send a formatted code block';
  }
  if (input) {
    input.placeholder = enabled ? 'Paste or write code...' : 'Write a message...';
    input.maxLength = enabled ? 12000 : 300;
  }
}

async function sendChatFile(file) {
  if (!file || !state.roomJoined || !state.supabase) return;
  if (file.size > CHAT_FILE_MAX_BYTES) {
    showToast('Files must be 10 MB or smaller.', '⚠️');
    return;
  }
  const id = crypto.randomUUID();
  try {
    const upload = await api('/api/rooms/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room: state.room,
        peerId: state.peerId,
        name: file.name,
        size: file.size
      })
    });
    const { error } = await state.supabase.storage
      .from(window.SUPABASE_CONFIG.storageBucket)
      .uploadToSignedUrl(upload.path, upload.token, file, {
        contentType: file.type || 'application/octet-stream'
      });
    if (error) throw error;
    const message = {
      type: 'chat-file',
      id,
      path: upload.path,
      name: file.name,
      size: file.size
    };
    if (await broadcastChatMessage(message)) {
      if (!rememberRoomEvent(id)) {
        addChatFileMessage(message, state.name, true, id);
      }
    }
  } catch (error) {
    console.warn('File transfer failed:', error);
    showToast('Could not send that file.', '⚠️');
  }
}

function makePeerConnection() {
  const peer = arguments[0];
  if (!peer) return null;
  if (state.connections.has(peer.id)) return state.connections.get(peer.id);
  const peerConfig = state.chatOnly
    ? rtcConfig
    : { ...rtcConfig, bundlePolicy: 'max-bundle', iceCandidatePoolSize: 10 };
  const pc = new RTCPeerConnection(peerConfig);
  pc._peerId = peer.id;
  pc._iceRestartAttempts = 0;
  state.connections.set(peer.id, pc);
  state.peers.set(peer.id, peer);
  addLocalTracksToPeer(pc);
  pc.onnegotiationneeded = async () => {
    if (!pc._initialOfferSent || !shouldCreateOffer(peer) || pc.signalingState !== 'stable' || pc._offerInProgress) return;
    pc._offerInProgress = true;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!await signal(peer, { type: 'offer', sdp: offer.sdp })) {
        await pc.setLocalDescription({ type: 'rollback' });
      }
    } catch (error) {
      console.warn('Media renegotiation failed:', error);
      setCallStatus('Could not add camera or microphone to the call. Please retry.', false);
    } finally {
      pc._offerInProgress = false;
    }
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      signal(peer, { type: 'candidate', candidate: candidate.toJSON() });
    }
  };
  pc.ontrack = ({ streams, track }) => {
    const video = document.querySelector(`#remote-video-${CSS.escape(peer.id)}`);
    if (video) {
      if (streams[0]) {
        video.srcObject = streams[0];
      } else {
        pc._remoteStream ||= new MediaStream();
        if (!pc._remoteStream.getTracks().some(remoteTrack => remoteTrack.id === track.id)) {
          pc._remoteStream.addTrack(track);
        }
        video.srcObject = pc._remoteStream;
      }
      video.style.display = 'block';
      video.play().catch(error => console.warn('Remote video playback was blocked:', error));
    }
    if (track.kind === 'video') setRemoteCameraState(peer.id, true);
    updateCallStatus();
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      pc._iceRestartAttempts = 0;
      updateCallStatus();
    } else if (pc.connectionState === 'failed') {
      updateCallStatus();
      restartIceConnection(peer, pc);
    } else if (['disconnected', 'closed'].includes(pc.connectionState)) {
      updateCallStatus();
    } else {
      updateCallStatus();
    }
  };
  return pc;
}

function updateCallStatus() {
  if (state.chatOnly) {
    if (state.pollError) {
      setCallStatus(`Room connection error: ${state.pollError}`, false);
    } else if (state.peers.size) {
      const participants = state.peers.size + (state.roomJoined ? 1 : 0);
      setCallStatus(`Chat active · ${participants} participants`, true);
    } else {
      setCallStatus('Waiting for chat participants (1/10)', false);
    }
    return;
  }

  const peers = [...state.connections.values()];
  const connected = peers.filter(pc => pc.connectionState === 'connected').length;
  const restarting = peers.some(pc => pc._iceRestartAttempts > 0 && pc.connectionState !== 'connected' && pc.connectionState !== 'closed');
  const failed = peers.some(pc => pc.connectionState === 'failed');
  const disconnected = peers.some(pc => pc.connectionState === 'disconnected');
  if (connected) setCallStatus(`Connected to ${connected} participant${connected === 1 ? '' : 's'}`, true);
  else if (state.signalError) setCallStatus(`Signaling error: ${state.signalError}`, false);
  else if (state.pollError) setCallStatus(`Room connection error: ${state.pollError}`, false);
  else if (restarting) setCallStatus('Network path failed. Retrying connection…', false);
  else if (failed) setCallStatus('Could not connect. Check both devices’ network connection and retry.', false);
  else if (disconnected) setCallStatus('Connection interrupted. Reconnecting…', false);
  else if (state.peers.size) setCallStatus('Connecting to participants…', false);
  else setCallStatus(`Waiting for participant (1/${state.chatOnly ? 10 : 2})`, false);
}

function createRemoteTile(peer) {
  const container = $('remoteVideos');
  if (!container || document.getElementById(`remote-card-${peer.id}`)) return;
  $('remoteWaitingCard')?.remove();
  const card = document.createElement('div');
  card.className = 'video-card remote';
  card.id = `remote-card-${peer.id}`;
  card.innerHTML = `<video id="remote-video-${peer.id}" autoplay playsinline></video><div id="remote-fallback-${peer.id}" class="video-placeholder"><span style="font-size: 24px;">👤</span><span>Connecting…</span></div><div class="video-badge"><span>${peer.name}</span></div>`;
  container.appendChild(card);
}

function removeRemotePeer(peerId) {
  state.connections.get(peerId)?.close();
  state.connections.delete(peerId);
  state.peers.delete(peerId);
  state.pendingCandidates.delete(peerId);
  document.getElementById(`remote-card-${peerId}`)?.remove();
  if (!state.peers.size && $('remoteVideos')) {
    $('remoteVideos').innerHTML = '<div id="remoteWaitingCard" class="video-card remote"><div class="video-placeholder"><span style="font-size: 24px;">👥</span><span id="remoteStatusMessage">Waiting for participants to join…</span><button type="button" id="copyShareBtn" class="btn-quiet" style="margin-top: 8px; font-size: 11px;">📋 Share Room Code</button></div></div>';
  }
  updateCallStatus();
}

async function signal(peer, message) {
  if (!state.room || !peer) return false;
  const outgoingMessage = { ...message, signalId: crypto.randomUUID() };
  const payload = { room: state.room, from: state.peerId, to: peer.id, message: outgoingMessage };

  if (state.socket?.connected && state.socketReady) {
    try {
      const response = await new Promise((resolve) => {
        state.socket.timeout(2500).emit('room:signal', payload, (timeoutError, result) => {
          resolve({ timeoutError, result });
        });
      });
      if (!response.timeoutError && response.result?.ok) {
        state.signalError = '';
        return true;
      }
      if (!response.timeoutError && !response.result?.fallback) {
        throw new Error(response.result?.error || 'Socket.IO rejected the signaling message.');
      }
    } catch (error) {
      console.warn('Socket.IO signaling failed; using room polling:', error.message);
    }
  }

  try {
    await api('/api/rooms/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    state.signalError = '';
    updateCallStatus();
    return true;
  } catch (error) {
    state.signalError = error.message;
    console.warn('Signaling request failed:', error.message);
    updateCallStatus();
    return false;
  }
}

async function applyPendingCandidates(pc) {
  const candidates = state.pendingCandidates.get(pc._peerId) || [];
  state.pendingCandidates.delete(pc._peerId);
  for (const candidate of candidates) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      console.warn('Queued ICE candidate ignored', error);
    }
  }
}

async function offerPeer(peer) {
  const pc = makePeerConnection(peer);
  pc._peerId = peer.id;
  if (pc._offerInProgress || pc.signalingState !== 'stable') return;
  pc._offerInProgress = true;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sent = await signal(peer, { type: 'offer', sdp: offer.sdp });
    if (sent) {
      pc._initialOfferSent = true;
    } else {
      await pc.setLocalDescription({ type: 'rollback' });
    }
    updateCallStatus();
  } finally {
    pc._offerInProgress = false;
  }
}

async function handleSignal(packet) {
  const signalId = packet.message?.signalId || packet.id;
  if (signalId && state.handledSignals.has(signalId)) return;
  if (signalId) {
    state.handledSignals.add(signalId);
    if (state.handledSignals.size > 500) {
      state.handledSignals.delete(state.handledSignals.values().next().value);
    }
  }
  const peer = state.peers.get(packet.from) || { id: packet.from, name: 'Practice partner' };
  state.peers.set(peer.id, peer);
  createRemoteTile(peer);
  const pc = makePeerConnection(peer);
  pc._peerId = peer.id;
  const msg = packet.message;
  if (msg.type === 'offer') {
    await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
    await applyPendingCandidates(pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await signal(peer, { type: 'answer', sdp: answer.sdp });
    updateCallStatus();
  } else if (msg.type === 'answer') {
    await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    await applyPendingCandidates(pc);
  } else if (msg.type === 'candidate' && msg.candidate) {
    if (pc.remoteDescription) {
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch (error) {
        console.warn('ICE candidate ignored', error);
      }
    } else {
      if (!state.pendingCandidates.has(peer.id)) state.pendingCandidates.set(peer.id, []);
      state.pendingCandidates.get(peer.id).push(msg.candidate);
    }
  }
}

function shouldCreateOffer(peer) {
  return peer && state.peerId.localeCompare(peer.id) < 0;
}

async function restartIceConnection(peer, pc) {
  if (!shouldCreateOffer(peer) || pc._iceRestartAttempts > 0 || pc.signalingState !== 'stable') return;

  pc._iceRestartAttempts += 1;
  updateCallStatus();
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    const sent = await signal(peer, { type: 'offer', sdp: offer.sdp });
    if (!sent) setCallStatus('Could not retry connection. Check signaling and network settings.', false);
  } catch (error) {
    console.warn('ICE restart failed:', error);
    setCallStatus('Connection retry failed. Check both devices’ network connection and retry.', false);
  }
}

async function poll() {
  if (!state.room || state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    const data = await api(`/api/rooms/poll?room=${encodeURIComponent(state.room)}&peerId=${encodeURIComponent(state.peerId)}`);
    const currentPeerIds = new Set(data.peers.map(peer => peer.id));
    for (const peerId of state.peers.keys()) {
      if (!currentPeerIds.has(peerId)) removeRemotePeer(peerId);
    }
    for (const peer of data.peers) {
      state.peers.set(peer.id, peer);
      createRemoteTile(peer);
      const pc = makePeerConnection(peer);
      pc._peerId = peer.id;
      if (shouldCreateOffer(peer) && !pc._initialOfferSent && pc.signalingState === 'stable') {
        await offerPeer(peer);
      }
    }
    for (const packet of data.signals) {
      await handleSignal(packet);
    }
    for (const message of data.messages || []) {
      handleRoomEvent(message);
    }
    state.pollError = '';
    updateCallStatus();
  } catch (err) {
    console.warn('Poll error:', err.message);
    state.pollError = err.message;
    updateCallStatus();
  } finally {
    state.pollInFlight = false;
  }
}

function startPolling() {
  clearInterval(state.polling);
  poll();
  state.polling = setInterval(poll, 5000);
}

function startSocketSignaling() {
  if (!window.SOCKET_SIGNALING_ENABLED || typeof window.io !== 'function') return;

  const socket = window.io(window.location.origin, {
    path: '/socket.io',
    autoConnect: false,
    transports: ['websocket'],
    upgrade: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000
  });
  state.socket = socket;
  socket.on('connect', () => {
    state.socketReady = false;
    updateChatStatus();
    socket.emit('room:join', { room: state.room, peerId: state.peerId }, (response) => {
      state.socketReady = response?.ok === true;
      if (!state.socketReady) {
        console.warn('Socket.IO room join failed:', response?.error || 'Unknown signaling error');
        showToast(response?.error || 'Could not restore the room connection.', '⚠️');
        updateChatStatus();
        return;
      }
      for (const peer of response.peers || []) handlePeerJoined(peer);
      for (const message of response.messages || []) handleRoomEvent(message);
      state.pollError = '';
      state.signalError = '';
      updateChatStatus();
      updateCallStatus();
      if (!state.chatOnly) sendCameraStatus(Boolean(state.stream?.getVideoTracks().length));
    });
  });
  socket.on('room:signal', (packet) => {
    if (packet?.to !== state.peerId) return;
    handleSignal(packet).catch((error) => {
      console.warn('Could not process Socket.IO signaling message:', error);
    });
  });
  socket.on('room:event', handleRoomEvent);
  socket.on('room:peer-joined', ({ peer }) => handlePeerJoined(peer));
  socket.on('room:peer-left', ({ peerId }) => handlePeerLeft(peerId));
  socket.on('disconnect', () => {
    state.socketReady = false;
    updateChatStatus();
    updateCallStatus();
  });
  socket.on('connect_error', (error) => {
    state.socketReady = false;
    console.warn('Socket.IO connection failed; reconnecting:', error.message);
    updateChatStatus();
  });
  socket.connect();
}

async function initRoomPage() {
  const roomCode = window.ROOM_CODE || '';
  if (!roomCode) {
    window.location.href = '/join';
    return;
  }
  state.room = roomCode;
  state.peerId = getRoomPeerId(state.room);
  const urlParams = new URLSearchParams(window.location.search);
  const isHost = urlParams.get('host') === '1';
  state.chatOnly = urlParams.get('mode') === 'chat';
  document.body.classList.toggle('chat-only', state.chatOnly);

  // Extract display name
  const nameFromUrl = urlParams.get('name');
  state.customTopic = urlParams.get('topic')?.trim() || '';
  const storedName = getSavedDisplayName();
  state.name = (nameFromUrl || storedName || 'You').trim();
  if ($('localUserLabel')) $('localUserLabel').textContent = state.name;

  // Topic switcher
  showTopic();
  if ($('nextTopic')) {
    $('nextTopic').addEventListener('click', () => {
      const topics = window.PRACTICE_TOPICS || [];
      if (state.customTopic) {
        state.customTopic = '';
        state.topic = 0;
      } else {
        state.topic = (state.topic + 1) % (topics.length || 1);
      }
      showTopic();
    });
  }

  // Copy buttons
  const copyInvite = () => {
    const joinUrl = `${window.location.origin}/join?code=${encodeURIComponent(state.room)}`;
    navigator.clipboard.writeText(joinUrl).then(() => {
      showToast('Invite link copied to clipboard!', '📋');
    }).catch(() => {
      navigator.clipboard.writeText(state.room).then(() => {
        showToast(`Room code ${state.room} copied!`, '📋');
      });
    });
  };
  if ($('copyInviteBtn')) $('copyInviteBtn').addEventListener('click', copyInvite);
  if ($('copyShareBtn')) $('copyShareBtn').addEventListener('click', copyInvite);

  // Initialize camera and join room
  try {
    setCallStatus('Connecting to room…');
    const data = await api('/api/rooms/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: state.name, room: state.room, peerId: state.peerId, host: isHost, mode: urlParams.get('mode') === 'chat' ? 'chat' : 'video' })
    });
    state.roomJoined = true;
    state.chatOnly = data.mode === 'chat';
    document.body.classList.toggle('chat-only', state.chatOnly);
    updateChatStatus();
    data.peers.forEach(peer => {
      state.peers.set(peer.id, peer);
      createRemoteTile(peer);
      if (!state.chatOnly) makePeerConnection(peer);
    });
    if (state.chatOnly) setCallStatus('P2P chat room · no camera or microphone');
    try {
      await startSupabaseRoomChannel();
    } catch (error) {
      console.error('Could not connect to shared Supabase room realtime:', error);
      showToast(error.message, '⚠️');
    }
    startSocketSignaling();
    startPolling();
  } catch (err) {
    setCallStatus(`Error: ${err.message}`);
    showToast(err.message, '⚠️');
    return;
  }

  if ($('recordBtn')) $('recordBtn').addEventListener('click', startBrowserRecording);
  if ($('stopBtn')) $('stopBtn').addEventListener('click', stopBrowserRecording);
  if ($('checkTextBtn')) $('checkTextBtn').addEventListener('click', () => {
    checkGrammar($('manualTranscript')?.value || '');
  });

  // Device permissions should not prevent the peer from joining the room.
  if (!state.chatOnly) {
    try {
      setCallStatus(state.peers.size ? 'Starting camera & audio…' : 'Waiting for participant (1/2)');
      await getMedia();
    } catch (err) {
      console.warn('Media setup failed:', err);
      showToast('Joined without camera or microphone. Check browser permissions.', '⚠️');
    }
  }
  updateCallStatus();
  showToast(`Joined room ${state.room}`, '🎉');

  // Camera & Mic toggles
  if ($('cameraBtn')) $('cameraBtn').addEventListener('click', toggleCamera);
  if ($('micBtn')) $('micBtn').addEventListener('click', toggleMic);
  if ($('shareMediaBtn')) $('shareMediaBtn').addEventListener('click', toggleMediaShare);
  if ($('hangupBtn')) $('hangupBtn').addEventListener('click', leaveRoom);
  if ($('leaveBtn')) $('leaveBtn').addEventListener('click', leaveRoom);

  if ($('chatForm')) $('chatForm').addEventListener('submit', (event) => {
    event.preventDefault();
    sendChatMessage();
  });
  if ($('chatCodeBtn')) $('chatCodeBtn').addEventListener('click', () => {
    setChatCodeMode(!state.codeMode);
    $('chatInput')?.focus();
  });
  if ($('chatInput')) $('chatInput').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (state.codeMode && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    $('chatForm')?.requestSubmit();
  });
  if ($('chatAttachBtn')) $('chatAttachBtn').addEventListener('click', () => $('chatFileInput')?.click());
  if ($('chatFileInput')) $('chatFileInput').addEventListener('change', async (event) => {
    await sendChatFile(event.target.files[0]);
    event.target.value = '';
  });
}

function leaveRoom() {
  if (state.room) {
    const leaveData = { room: state.room, peerId: state.peerId };
    if (state.socket?.connected && state.socketReady) {
      state.socket.emit('room:leave', leaveData);
    }
    navigator.sendBeacon('/api/rooms/leave', new Blob([JSON.stringify(leaveData)], { type: 'application/json' }));
  }
  state.socket?.disconnect();
  state.socket = null;
  state.socketReady = false;
  state.roomJoined = false;
  state.realtimeReady = false;
  clearInterval(state.realtimeTokenRefresh);
  if (state.roomChannel && state.supabase) {
    state.supabase.removeChannel(state.roomChannel);
  }
  clearInterval(state.polling);
  if (state.screenTrack) stopMediaShare();
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }
  for (const pc of state.connections.values()) pc.close();
  state.connections.clear();
  window.location.href = '/';
}
window.addEventListener('beforeunload', leaveRoom);

async function toggleCamera() {
  const btn = $('cameraBtn');
  const videoTrack = state.stream?.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.stop();
    state.stream.removeTrack(videoTrack);
    for (const pc of state.connections.values()) {
      const sender = pc.getSenders().find(s => s.track === videoTrack || s.track?.kind === 'video');
      if (sender) {
        try { await sender.replaceTrack(null); } catch (e) { console.warn(e); }
      }
    }
    if (btn) btn.classList.add('muted');
    if ($('localVideo')) $('localVideo').style.display = 'none';
    if ($('localFallback')) $('localFallback').style.display = 'flex';
    if ($('localFallback')) $('localFallback').querySelector('span:last-child').textContent = 'Camera off';
    sendCameraStatus(false);
  } else {
    try {
      if (btn) btn.disabled = true;
      const media = await navigator.mediaDevices.getUserMedia({ video: true });
      const newTrack = media.getVideoTracks()[0];
      if (!state.stream) state.stream = new MediaStream();
      state.stream.addTrack(newTrack);
      if ($('localVideo')) {
        $('localVideo').srcObject = state.stream;
        $('localVideo').style.display = 'block';
      }
      if ($('localFallback')) $('localFallback').style.display = 'none';
      if ($('localFallback')) $('localFallback').querySelector('span:last-child').textContent = 'Camera loading…';
      for (const pc of state.connections.values()) {
        const sender = pc.getSenders().find(s => s.track === null || s.track?.kind === 'video');
        if (sender) {
          try { await sender.replaceTrack(newTrack); } catch (e) { console.warn(e); }
        } else {
          pc.addTrack(newTrack, state.stream);
        }
      }
      if (btn) btn.classList.remove('muted');
      sendCameraStatus(true);
    } catch (err) {
      console.error('Could not restart camera:', err);
      showToast('Could not restart camera.', '⚠️');
    } finally {
      if (btn) btn.disabled = false;
    }
  }
}

function toggleMic() {
  const btn = $('micBtn');
  const track = state.stream?.getAudioTracks()[0];
  if (track) {
    track.enabled = !track.enabled;
    if (btn) btn.classList.toggle('muted', !track.enabled);
    const ind = $('localAudioIndicator');
    if (ind) ind.style.color = track.enabled ? 'var(--emerald-400)' : 'var(--rose-500)';
    showToast(track.enabled ? 'Microphone active' : 'Microphone muted', track.enabled ? '🎙️' : '🔇');
  }
}

async function toggleMediaShare() {
  const btn = $('shareMediaBtn');
  if (state.screenTrack) {
    stopMediaShare();
    return;
  }

  try {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const screenTrack = displayStream.getVideoTracks()[0];
    const senders = [...state.connections.values()]
      .map(pc => pc.getSenders().find(item => item.track?.kind === 'video'))
      .filter(Boolean);
    if (!senders.length || !screenTrack) {
      displayStream.getTracks().forEach(track => track.stop());
      showToast('Join a connected room before sharing media.', '⚠️');
      return;
    }
    await Promise.all(senders.map(sender => sender.replaceTrack(screenTrack)));
    state.screenTrack = screenTrack;
    if ($('localVideo')) {
      $('localVideo').srcObject = new MediaStream([screenTrack]);
      $('localVideo').style.display = 'block';
    }
    if ($('localFallback')) $('localFallback').style.display = 'none';
    if (btn) {
      btn.classList.add('active');
      btn.textContent = '⏹️';
      btn.title = 'Stop sharing media';
    }
    screenTrack.onended = stopMediaShare;
    showToast('Media sharing is on', '🖥️');
  } catch (err) {
    if (err.name !== 'AbortError' && err.name !== 'NotAllowedError') {
      console.warn('Media sharing failed:', err);
      showToast('Could not start media sharing.', '⚠️');
    }
  }
}

async function stopMediaShare() {
  const screenTrack = state.screenTrack;
  if (!screenTrack) return;
  screenTrack.onended = null;
  screenTrack.stop();
  state.screenTrack = null;
  const cameraTrack = state.stream?.getVideoTracks()[0] || null;
  const senders = [...state.connections.values()]
    .map(pc => pc.getSenders().find(item => item.track?.kind === 'video' || item.track === screenTrack))
    .filter(Boolean);
  await Promise.all(senders.map(sender => sender.replaceTrack(cameraTrack)));
  if ($('localVideo')) {
    $('localVideo').srcObject = state.stream || null;
    $('localVideo').style.display = cameraTrack ? 'block' : 'none';
  }
  if ($('localFallback')) $('localFallback').style.display = cameraTrack ? 'none' : 'flex';
  const btn = $('shareMediaBtn');
  if (btn) {
    btn.classList.remove('active');
    btn.textContent = '🖥️';
    btn.title = 'Share screen or media';
  }
}

// --------------------------------------------------------------------------
// Browser Speech Recognition
// --------------------------------------------------------------------------
function startBrowserRecording() {
  if (!state.stream) return showToast('Microphone stream not available.', '⚠️');
  state.audioChunks = [];
  state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = state.audioContext.createMediaStreamSource(state.stream);
  state.recorderNode = state.audioContext.createScriptProcessor(4096, 1, 1);
  state.recorderNode.onaudioprocess = (e) => {
    state.audioChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  source.connect(state.recorderNode);
  state.recorderNode.connect(state.audioContext.destination);

  state.recording = true;
  if ($('recordBtn')) $('recordBtn').classList.add('recording');
  if ($('recordBtn')) $('recordBtn').disabled = true;
  if ($('stopBtn')) $('stopBtn').disabled = false;
  if ($('recordingState')) $('recordingState').textContent = 'Recording…';
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}

async function stopBrowserRecording() {
  if (!state.recording) return;
  state.recording = false;
  state.recorderNode.disconnect();
  const sampleRate = state.audioContext.sampleRate;
  await state.audioContext.close();

  const length = state.audioChunks.reduce((n, c) => n + c.length, 0);
  const samples = new Float32Array(length);
  let offset = 0;
  state.audioChunks.forEach(c => { samples.set(c, offset); offset += c.length; });

  if ($('recordBtn')) $('recordBtn').classList.remove('recording');
  if ($('recordBtn')) $('recordBtn').disabled = false;
  if ($('stopBtn')) $('stopBtn').disabled = true;
  if ($('recordingState')) $('recordingState').textContent = 'Transcribing…';

  const form = new FormData();
  form.append('audio', encodeWav(samples, sampleRate), 'practice.wav');

  try {
    const data = await api('/api/transcribe', { method: 'POST', body: form });
    await useTranscript(data.transcript, 'Browser Mic STT');
  } catch (err) {
    if ($('transcript')) {
      $('transcript').textContent = err.message;
      $('transcript').classList.add('empty');
    }
    showToast(err.message, '⚠️');
  } finally {
    if ($('recordingState')) $('recordingState').textContent = 'Ready';
  }
}

async function useTranscript(transcript, source = '') {
  const transcriptEl = $('transcript');
  if (transcriptEl) {
    transcriptEl.textContent = transcript;
    transcriptEl.classList.remove('empty');
  }
  if ($('manualTranscript')) $('manualTranscript').value = transcript;
  if (source && $('recordingState')) $('recordingState').textContent = source;
  await checkGrammar(transcript);
}

// --------------------------------------------------------------------------
// Xynoz AI Grammar & Feedback
// --------------------------------------------------------------------------
function escapeHtml(value) {
  const el = document.createElement('div');
  el.textContent = value || '';
  return el.innerHTML;
}

async function checkGrammar(text) {
  const cleaned = text.trim();
  if (!cleaned) return showToast('Please provide speech or text to check.', 'ℹ️');

  const checkBtn = $('checkTextBtn');
  if (checkBtn) checkBtn.disabled = true;
  if ($('feedbackEmpty')) $('feedbackEmpty').hidden = true;
  if ($('feedbackContent')) $('feedbackContent').hidden = false;
  if ($('correctedText')) $('correctedText').textContent = 'Analyzing your sentence…';
  if ($('feedbackSummary')) $('feedbackSummary').textContent = '';
  if ($('issuesList')) $('issuesList').replaceChildren();

  try {
    const data = await api('/api/grammar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: cleaned })
    });
    const feedback = data.feedback;
    if ($('correctedText')) $('correctedText').textContent = feedback.corrected;
    if ($('feedbackSummary')) $('feedbackSummary').textContent = feedback.summary;

    const issuesList = $('issuesList');
    if (issuesList) {
      issuesList.replaceChildren();
      if (feedback.issues && feedback.issues.length > 0) {
        feedback.issues.forEach(issue => {
          const item = document.createElement('div');
          item.className = 'issue-item';

          const diffRow = document.createElement('div');
          diffRow.className = 'issue-diff';
          diffRow.innerHTML = `<del>${escapeHtml(issue.original)}</del> <span>→</span> <ins>${escapeHtml(issue.correction)}</ins>`;

          const exp = document.createElement('p');
          exp.textContent = issue.explanation;

          item.append(diffRow, exp);
          issuesList.append(item);
        });
      } else {
        const perfectMsg = document.createElement('div');
        perfectMsg.className = 'issue-item';
        perfectMsg.innerHTML = '<span style="color: var(--emerald-400); font-weight: 600;">✨ Great job! No grammatical errors found in this sentence.</span>';
        issuesList.append(perfectMsg);
      }
    }
    showToast('AI Feedback ready!', '✦');
  } catch (err) {
    if ($('correctedText')) $('correctedText').textContent = 'Feedback currently unavailable';
    if ($('feedbackSummary')) $('feedbackSummary').textContent = err.message;
    showToast(err.message, '⚠️');
  } finally {
    if (checkBtn) checkBtn.disabled = false;
  }
}
