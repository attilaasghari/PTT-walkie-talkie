'use strict';

// ============================================================
// PTT APP — client
// Step 5: mobile polish (wake lock, long-press guard, focus).
// ============================================================

(() => {
  const BUILD = 'v5-2026-10-31';
  const $ = (sel) => document.querySelector(sel);

  const mainView   = $('#main-view');
  const chanView   = $('#channel-view');
  const channelName= $('#channel-name');
  const clockEls   = [$('#clock'), $('#clock-2')];
  const statusDot  = $('#status-dot');
  const statusText = $('#status-text');
  const pttBtn     = $('#ptt-btn');
  const pttLabel   = $('#ptt-label');
  const btnChannel = $('#btn-channel');
  const btnPower   = $('#btn-power');
  const powerState = $('#power-state');
  const btnBack    = $('#btn-back');
  const unitsBody  = $('#units-body');
  const unitsCount = $('#units-count');
  const channelBtns = Array.from(document.querySelectorAll('.channel-btn'));

  console.log('%c PTT APP build:', 'color:#FFB000;font-weight:bold', BUILD);

  const MAX_UTTERANCE_MS = 30000;

  const state = {
    powered: true,
    socket: null,
    deviceId: null,
    channel: null,
    busyBy: null,
    selfTransmitting: false,
    devices: [],

    mediaStream: null,
    recorder: null,
    recorderMimeType: '',
    capturedChunks: [],
    captureTimer: null,
    captureStarting: false,
    flushOnNextChunk: false,
    flushFallbackTimer: null,
    pttStopPending: false,

    playingAudio: null,
    playbackQueue: [],
    audioCtxUnlocked: false,

    lastMicError: null,
    wakeLock: null,
  };

  // ---------- clock ----------
  function tickClock() {
    const d = new Date();
    const s = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
    for (const el of clockEls) if (el) el.textContent = s;
  }
  setInterval(tickClock, 250); tickClock();

  // ---------- views ----------
  function showMain() { chanView.classList.add('view--hidden'); mainView.classList.remove('view--hidden'); }
  function showChannelSelect() {
    mainView.classList.add('view--hidden'); chanView.classList.remove('view--hidden');
    for (const b of channelBtns) b.classList.toggle('is-current', b.dataset.channel === state.channel);
  }

  // ---------- render ----------
  function renderStatus() {
    let kind='idle', text='IDLE';
    if (!state.powered) { kind='idle'; text='OFFLINE'; }
    else if (!state.channel) { kind='idle'; text='NO CHANNEL'; }
    else if (state.selfTransmitting) { kind='active'; text='TRANSMITTING'; }
    else if (state.busyBy && state.busyBy !== state.deviceId) { kind='busy'; text=`RX — ${state.busyBy.toUpperCase()}`; }
    else { kind='active'; text='READY'; }
    statusDot.classList.remove('is-active','is-busy'); statusText.classList.remove('is-active','is-busy');
    if (kind==='active'){statusDot.classList.add('is-active');statusText.classList.add('is-active');}
    else if (kind==='busy'){statusDot.classList.add('is-busy');statusText.classList.add('is-busy');}
    statusText.textContent = text;
  }
  function renderChannelName() { channelName.textContent = state.channel || '—'; }
  function renderPtt() {
    pttBtn.classList.remove('is-transmitting','is-busy');
    if (!state.powered) { pttBtn.disabled=true; pttLabel.textContent='POWER OFF'; return; }
    if (!state.channel) { pttBtn.disabled=true; pttLabel.textContent='SELECT CHANNEL'; return; }
    if (state.lastMicError) { pttBtn.disabled=true; pttBtn.classList.add('is-busy'); pttLabel.textContent='MIC ERROR'; return; }
    if (state.selfTransmitting) { pttBtn.disabled=false; pttBtn.classList.add('is-transmitting'); pttLabel.textContent='TRANSMITTING'; return; }
    if (state.busyBy && state.busyBy !== state.deviceId) { pttBtn.disabled=true; pttBtn.classList.add('is-busy'); pttLabel.textContent='CHANNEL BUSY'; return; }
    pttBtn.disabled=false; pttLabel.textContent='HOLD TO TALK';
  }
  function renderPower() {
    btnPower.setAttribute('aria-pressed', String(state.powered));
    powerState.textContent = state.powered ? 'ON' : 'OFF';
  }
  function renderUnits() {
    const rows = state.devices.slice().sort((a,b)=>{
      if (a.isTransmitting !== b.isTransmitting) return a.isTransmitting ? -1 : 1;
      const ca = a.channel||'~~~~', cb = b.channel||'~~~~';
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    unitsCount.textContent = String(rows.length).padStart(2,'0');
    if (rows.length===0){ unitsBody.innerHTML = '<tr class="is-empty"><td colspan="3">NO UNITS</td></tr>'; return; }
    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const tr = document.createElement('tr');
      const tdId=document.createElement('td'); tdId.textContent=r.id;
      const tdCh=document.createElement('td'); tdCh.textContent=r.channel||'—';
      const tdIp=document.createElement('td'); tdIp.textContent=r.ip;
      if (r.isTransmitting) tdId.classList.add('is-tx');
      tr.append(tdId,tdCh,tdIp); frag.appendChild(tr);
    }
    unitsBody.replaceChildren(frag);
  }
  function renderAll(){ renderStatus(); renderChannelName(); renderPtt(); renderPower(); renderUnits(); }

  // ---------- wake lock ----------
  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator && state.powered) {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
      }
    } catch (_) { /* unsupported or denied */ }
  }
  async function releaseWakeLock() {
    try { if (state.wakeLock) await state.wakeLock.release(); } catch (_) {}
    state.wakeLock = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.powered) acquireWakeLock();
  });

  // ---------- capture ----------
  function pickRecorderMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4;codecs=mp4a.40.2','audio/mp4'];
    for (const c of candidates) { try { if (MediaRecorder.isTypeSupported(c)) return c; } catch(_){} }
    return '';
  }
  async function ensureMic() {
    if (state.mediaStream && state.mediaStream.active) return state.mediaStream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('getUserMedia unavailable (needs HTTPS or localhost)');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
    });
    state.mediaStream = stream;
    return stream;
  }
  function releaseMic() {
    if (state.mediaStream) { for (const t of state.mediaStream.getTracks()) { try { t.stop(); } catch(_){} } state.mediaStream = null; }
  }

  function emitPttStopOnce() {
    if (!state.pttStopPending) return;
    state.pttStopPending = false;
    if (state.socket) state.socket.emit('ptt:stop');
  }

  function finishAndSendNow(reason) {
    const chunks = state.capturedChunks.slice();
    state.capturedChunks = [];
    if (!chunks.length) { emitPttStopOnce(); return; }
    const blob = new Blob(chunks, { type: state.recorderMimeType });
    if (!blob.size || blob.size > 4 * 1024 * 1024) { emitPttStopOnce(); return; }
    blob.arrayBuffer().then((buf) => {
      if (state.socket && state.socket.connected) {
        state.socket.emit('audio', { mimeType: state.recorderMimeType, data: buf });
      }
      emitPttStopOnce();
    }).catch(() => emitPttStopOnce());
  }

  async function startTransmit() {
    if (!state.powered || !state.channel) return;
    if (state.selfTransmitting || state.captureStarting) return;
    if (state.busyBy && state.busyBy !== state.deviceId) return;

    state.captureStarting = true;
    state.lastMicError = null;
    try {
      const stream = await ensureMic();
      const mime = pickRecorderMime();
      let rec;
      try { rec = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 24000 }) : new MediaRecorder(stream); }
      catch (_) { rec = new MediaRecorder(stream); }
      state.recorder = rec;
      state.recorderMimeType = rec.mimeType || mime || 'audio/webm';
      state.capturedChunks = [];
      state.flushOnNextChunk = false;
      state.pttStopPending = true;

      rec.ondataavailable = (ev) => {
        if (!ev || !ev.data || ev.data.size === 0) return;
        if (state.flushOnNextChunk) {
          state.capturedChunks.push(ev.data);
          state.flushOnNextChunk = false;
          clearTimeout(state.flushFallbackTimer); state.flushFallbackTimer = null;
          finishAndSendNow('final-chunk');
        } else {
          state.capturedChunks.push(ev.data);
        }
      };
      rec.onerror = (e) => { console.warn('[app] recorder error', e); };

      state.selfTransmitting = true;
      state.busyBy = state.deviceId;
      renderAll();
      if (state.socket) state.socket.emit('ptt:start');

      try { rec.start(); } catch (e) { console.warn('[app] rec.start threw', e); }
      clearTimeout(state.captureTimer);
      state.captureTimer = setTimeout(() => { if (state.selfTransmitting) stopTransmit(); }, MAX_UTTERANCE_MS);
    } catch (err) {
      state.lastMicError = (err && err.name) || 'MicError';
      state.selfTransmitting = false; state.busyBy = null; state.recorder = null; state.capturedChunks = [];
      clearTimeout(state.captureTimer); state.captureTimer = null;
      emitPttStopOnce();
      renderAll();
    } finally {
      state.captureStarting = false;
    }
  }

  function stopTransmit() {
    const rec = state.recorder;

    clearTimeout(state.captureTimer); state.captureTimer = null;
    state.selfTransmitting = false;
    if (state.busyBy === state.deviceId) state.busyBy = null;
    state.recorder = null;
    renderAll();

    if (!rec) { emitPttStopOnce(); return; }

    state.flushOnNextChunk = true;
    clearTimeout(state.flushFallbackTimer);
    state.flushFallbackTimer = setTimeout(() => {
      state.flushOnNextChunk = false;
      finishAndSendNow('fallback-400ms');
    }, 400);

    try {
      if (rec.state !== 'inactive') rec.stop();
      else { state.flushOnNextChunk = false; finishAndSendNow('already-inactive'); }
    } catch (_) {
      state.flushOnNextChunk = false;
      finishAndSendNow('stop-threw');
    }
  }

  // ---------- playback ----------
  function unlockPlayback() {
    if (state.audioCtxUnlocked) return;
    state.audioCtxUnlocked = true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        const ctx = new AC();
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf; src.connect(ctx.destination); src.start(0);
        setTimeout(()=>{ try{ ctx.close(); }catch(_){} }, 100);
      }
    } catch(_){}
  }
  document.addEventListener('click', unlockPlayback, { once: false });
  document.addEventListener('touchstart', unlockPlayback, { once: false, passive: true });

  function playIncomingClip(arrayBuffer, mimeType, fromId) {
    if (!arrayBuffer || !arrayBuffer.byteLength) return;
    const blob = new Blob([arrayBuffer], { type: mimeType || 'audio/webm' });
    const url = URL.createObjectURL(blob);
    const el = new Audio();
    el.preload = 'auto';
    el.src = url;
    state.playbackQueue.push({ url, el });
    pumpPlayback();
  }
  function pumpPlayback() {
    if (state.playingAudio) return;
    const next = state.playbackQueue.shift();
    if (!next) return;
    state.playingAudio = next.el;
    const done = () => {
      try { URL.revokeObjectURL(next.url); } catch(_){}
      if (state.playingAudio === next.el) state.playingAudio = null;
      pumpPlayback();
    };
    next.el.addEventListener('ended', done, { once: true });
    next.el.addEventListener('error', () => done(), { once: true });
    const p = next.el.play();
    if (p && typeof p.catch === 'function') p.catch(() => done());
  }
  function flushPlayback() {
    for (const item of state.playbackQueue) { try { URL.revokeObjectURL(item.url); } catch(_){} }
    state.playbackQueue.length = 0;
    if (state.playingAudio) { try { state.playingAudio.pause(); } catch(_){} try { state.playingAudio.src=''; } catch(_){} }
    state.playingAudio = null;
  }

  // ---------- socket ----------
  function connect() {
    if (state.socket) return;
    const socket = io({ transports: ['websocket','polling'] });
    state.socket = socket;

    socket.on('joined', (payload={}) => {
      if (payload.deviceId) state.deviceId = payload.deviceId;
      if (payload.channel !== undefined) state.channel = payload.channel || null;
      renderAll();
    });
    socket.on('devices:update', (list) => { state.devices = Array.isArray(list) ? list : []; renderUnits(); });
    socket.on('channel:busy', ({ byDeviceId }={}) => {
      state.busyBy = byDeviceId || null;
      if (state.selfTransmitting && state.busyBy !== state.deviceId) stopTransmit();
      renderAll();
    });
    socket.on('channel:free', () => { state.busyBy = null; renderAll(); });
    socket.on('audio', (msg={}) => {
      if (!msg || !msg.data) return;
      if (msg.fromDeviceId === state.deviceId) return;
      playIncomingClip(msg.data, msg.mimeType, msg.fromDeviceId);
    });
    socket.on('error', (payload={}) => {
      if (payload.message === 'Channel busy') { state.selfTransmitting = false; renderAll(); }
    });
    socket.on('disconnect', () => {
      if (state.selfTransmitting) stopTransmit();
      flushPlayback(); releaseMic();
      state.deviceId=null; state.channel=null; state.busyBy=null; state.devices=[];
      renderAll();
    });
  }

  function disconnect() {
    if (state.selfTransmitting) stopTransmit();
    flushPlayback(); releaseMic(); releaseWakeLock();
    if (state.socket) { try{state.socket.emit('leave');}catch(_){} try{state.socket.disconnect();}catch(_){} state.socket=null; }
    state.deviceId=null; state.channel=null; state.busyBy=null; state.devices=[];
    renderAll(); showChannelSelect();
  }

  // ---------- actions ----------
  function joinChannel(name) {
    if (!state.powered) return;
    state.channel = name; state.busyBy = null; state.selfTransmitting = false;
    state.lastMicError = null;
    flushPlayback();
    if (state.socket) state.socket.emit('join', { channel: name });
    renderAll(); showMain();
    acquireWakeLock();
  }
  function powerToggle() {
    state.powered = !state.powered;
    if (state.powered) {
      connect(); state.channel=null; state.busyBy=null; state.selfTransmitting=false; state.lastMicError=null;
      renderAll(); showChannelSelect();
    } else { disconnect(); showMain(); }
  }

  // ---------- bindings ----------
  btnChannel.addEventListener('click', () => { if (state.powered) showChannelSelect(); });
  btnBack.addEventListener('click', () => showMain());
  for (const b of channelBtns) {
    b.addEventListener('click', () => { unlockPlayback(); joinChannel(b.dataset.channel); });
  }
  btnPower.addEventListener('click', powerToggle);

  function onPress(e){ if (e) e.preventDefault(); unlockPlayback(); startTransmit(); }
  function onRelease(e){ if (e) e.preventDefault(); stopTransmit(); }

  pttBtn.addEventListener('mousedown', onPress);
  window.addEventListener('mouseup', () => stopTransmit());
  pttBtn.addEventListener('mouseleave', () => stopTransmit());
  pttBtn.addEventListener('touchstart', onPress, { passive: false });
  pttBtn.addEventListener('touchend', onRelease, { passive: false });
  pttBtn.addEventListener('touchcancel', onRelease, { passive: false });

  // mobile long-press / context-menu guards
  pttBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('#ptt-btn')) e.preventDefault();
  });

  window.addEventListener('blur', () => stopTransmit());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopTransmit(); releaseWakeLock(); }
    else if (state.powered) acquireWakeLock();
  });
  window.addEventListener('pagehide', () => { stopTransmit(); releaseWakeLock(); });
  window.addEventListener('beforeunload', () => {
    try { state.socket && state.socket.emit('ptt:stop'); } catch(_) {}
  });

  // ---------- boot ----------
  state.powered = true;
  renderAll();
  connect();
  showChannelSelect();
})();