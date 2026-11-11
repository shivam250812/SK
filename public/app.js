// Browser side of the Virtual KAM call.
// Captures the microphone as 16 kHz PCM, streams it to the server over a
// WebSocket, plays the model's 24 kHz PCM replies, and renders the transcript,
// the agent's activity and the call summary.

const $ = (id) => document.getElementById(id);
const els = {
  orb: $('orb'),
  status: $('status'),
  timer: $('timer'),
  callBtn: $('callBtn'),
  muteBtn: $('muteBtn'),
  language: $('language'),
  voice: $('voice'),
  hint: $('hint'),
  transcript: $('transcript'),
  metrics: $('metrics'),
  activity: $('activity'),
  summaryCard: $('summaryCard'),
  summary: $('summary'),
  sellerChip: $('sellerChip'),
  foot: $('foot'),
};

const OUTPUT_RATE = 24000;
const defaultHint = els.hint.textContent;

let kamName = 'KAM';
let ws = null;
let micStream = null;
let micCtx = null;
let playCtx = null;
let micAnalyser = null;
let outAnalyser = null;
let outGain = null;
let nextPlayTime = 0;
let inCall = false;
let live = false;
let muted = false;
let callStart = 0;
let timerId = null;
let lastBubble = null;
const playing = new Set();

// ---------- account snapshot ----------

const rupees = (n) => '₹' + n.toLocaleString('en-IN');

function renderSnapshot({ seller, metrics }) {
  els.sellerChip.textContent = `${seller.name} · ${seller.store} · ${seller.category}`;
  const l = metrics.lastMonth;
  const t = metrics.thisMonth;
  const pct = (a, b) => `${b >= a ? '+' : ''}${Math.round(((b - a) / a) * 1000) / 10}%`;
  const rows = [
    ['Sales', rupees(l.sales), rupees(t.sales), pct(l.sales, t.sales), 'bad'],
    ['Orders', l.orders, t.orders, pct(l.orders, t.orders), 'bad'],
    ['Cancellation rate', l.cancellationRate + '%', t.cancellationRate + '%', `+${t.cancellationRate - l.cancellationRate} pts`, 'bad'],
    ['Average selling price', rupees(l.asp), rupees(t.asp), 'no change', 'flat'],
    ['Out-of-stock products', l.oosProducts, t.oosProducts, `+${t.oosProducts - l.oosProducts}`, 'bad'],
  ];
  els.metrics.innerHTML =
    '<tr><th>Metric</th><th>Last month</th><th>This month</th><th>Change</th></tr>' +
    rows
      .map(([m, a, b, d, cls]) => `<tr><td>${m}</td><td>${a}</td><td>${b}</td><td class="delta ${cls}">${d}</td></tr>`)
      .join('');
}

fetch('/api/seller')
  .then((r) => r.json())
  .then((data) => {
    kamName = data.kamName || kamName;
    for (const name of data.voices || []) els.voice.add(new Option(name, name, false, name === data.defaultVoice));
    renderSnapshot(data);
  })
  .catch(() => {});

// ---------- UI helpers ----------

function setStatus(text) {
  els.status.textContent = text;
}

function showError(message) {
  els.hint.textContent = message;
  els.hint.classList.add('error');
}

function clearEmpty(container) {
  const empty = container.querySelector('.empty');
  if (empty) empty.remove();
}

function addTranscript(role, text) {
  clearEmpty(els.transcript);
  if (!lastBubble || lastBubble.dataset.role !== role) {
    lastBubble = document.createElement('div');
    lastBubble.className = `bubble ${role}`;
    lastBubble.dataset.role = role;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = role === 'kam' ? kamName : 'Seller';
    const body = document.createElement('span');
    body.className = 'body';
    lastBubble.append(who, body);
    els.transcript.append(lastBubble);
  }
  const body = lastBubble.querySelector('.body');
  // Separate speech segments that arrive without a space between sentences.
  const needsSpace = /[.?!।]$/.test(body.textContent) && !/^\s/.test(text);
  body.textContent += (needsSpace ? ' ' : '') + text;
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function addActivity({ kind, label, action, name }) {
  clearEmpty(els.activity);
  const li = document.createElement('li');
  li.className = `item ${kind === 'action' ? 'action' : ''}`;
  const tag = document.createElement('div');
  tag.className = 'tag';
  tag.textContent = kind === 'action' ? 'Action taken' : kind === 'held' ? 'Waiting for seller' : 'Data check';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = action?.title || label || name;
  li.append(tag, title);
  if (action?.detail) {
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = action.detail;
    li.append(detail);
  }
  els.activity.append(li);
}

function renderSummary(summary) {
  const sections = [
    ['Key issues', summary.mainIssues],
    ['Recommendations', summary.recommendations],
    ['Actions taken on this call', summary.actionsTaken],
    ['Next steps', summary.nextSteps],
  ];
  els.summary.innerHTML = '';
  for (const [heading, items] of sections) {
    if (!items || !items.length) continue;
    const h = document.createElement('h3');
    h.textContent = heading;
    const ul = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = item;
      ul.append(li);
    }
    els.summary.append(h, ul);
  }
  els.summaryCard.hidden = false;
  els.summaryCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- audio out ----------

function playChunk(base64) {
  if (!playCtx) return;
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2));
  const buffer = playCtx.createBuffer(1, pcm.length, OUTPUT_RATE);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;

  const source = playCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(outGain);
  // Schedule chunks back to back so speech is gapless.
  const startAt = Math.max(playCtx.currentTime + 0.03, nextPlayTime);
  source.start(startAt);
  nextPlayTime = startAt + buffer.duration;
  playing.add(source);
  source.onended = () => playing.delete(source);
}

// The seller spoke over the agent: drop everything queued.
function stopPlayback() {
  for (const source of playing) {
    try {
      source.stop();
    } catch {}
  }
  playing.clear();
  nextPlayTime = 0;
}

const isSpeaking = () => playCtx && nextPlayTime > playCtx.currentTime + 0.05;

// ---------- orb ----------

function level(analyser) {
  if (!analyser) return 0;
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
  return peak / 128;
}

function animate() {
  if (!inCall) {
    els.orb.style.transform = 'scale(1)';
    els.orb.style.boxShadow = 'none';
    return;
  }
  const speaking = isSpeaking();
  const amount = speaking ? level(outAnalyser) : muted ? 0 : level(micAnalyser);
  els.orb.classList.toggle('listening', live && !speaking);
  els.orb.style.transform = `scale(${1 + Math.min(amount, 1) * 0.35})`;
  els.orb.style.boxShadow = `0 0 0 ${Math.round(amount * 40)}px rgba(${speaking ? '228,0,70' : '36,99,235'},0.15)`;
  if (live) setStatus(speaking ? `${kamName} is speaking` : muted ? 'You are muted' : 'Listening');
  requestAnimationFrame(animate);
}

// ---------- call lifecycle ----------

async function startCall() {
  els.callBtn.disabled = true;
  els.hint.classList.remove('error');
  els.hint.textContent = defaultHint;
  setStatus('Asking for microphone access');

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch {
    els.callBtn.disabled = false;
    setStatus('Microphone blocked');
    showError('This is a voice call, so it needs the microphone. Allow microphone access for this page and try again.');
    return;
  }

  // Reset the panels for a fresh call.
  els.transcript.innerHTML = '';
  els.activity.innerHTML = '';
  els.summaryCard.hidden = true;
  lastBubble = null;

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  micCtx = new AudioCtx({ sampleRate: 16000 });
  await micCtx.audioWorklet.addModule('pcm-worklet.js');
  const micSource = micCtx.createMediaStreamSource(micStream);
  micAnalyser = micCtx.createAnalyser();
  micAnalyser.fftSize = 512;
  const capture = new AudioWorkletNode(micCtx, 'pcm-capture');
  const silent = micCtx.createGain();
  silent.gain.value = 0;
  micSource.connect(micAnalyser);
  micSource.connect(capture);
  capture.connect(silent).connect(micCtx.destination); // keeps the worklet running, plays nothing

  playCtx = new AudioCtx();
  outGain = playCtx.createGain();
  outAnalyser = playCtx.createAnalyser();
  outAnalyser.fftSize = 512;
  outGain.connect(outAnalyser).connect(playCtx.destination);
  nextPlayTime = 0;

  let voiceReported = false;
  capture.port.onmessage = (event) => {
    if (!live || muted || ws?.readyState !== WebSocket.OPEN) return;
    ws.send(event.data);
    // Tell the server once when the seller is clearly speaking, so the agent
    // does not start work before it has been asked anything.
    if (!voiceReported && !isSpeaking()) {
      const pcm = new Int16Array(event.data);
      let peak = 0;
      for (let i = 0; i < pcm.length; i += 8) peak = Math.max(peak, Math.abs(pcm[i]));
      if (peak > 4000) {
        voiceReported = true;
        ws.send(JSON.stringify({ type: 'voice' }));
      }
    }
  };

  inCall = true;
  setStatus('Connecting');
  els.orb.classList.add('live');
  requestAnimationFrame(animate);

  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'start', sampleRate: micCtx.sampleRate, language: els.language.value, voice: els.voice.value }));
  ws.onmessage = (event) => handleServer(JSON.parse(event.data));
  ws.onclose = () => endCall('Call ended');
  ws.onerror = () => showError('Lost the connection to the server.');

  els.callBtn.textContent = 'End call';
  els.callBtn.classList.add('end');
  els.callBtn.disabled = false;
  els.muteBtn.hidden = false;
  els.language.disabled = els.voice.disabled = true;
}

function handleServer(msg) {
  switch (msg.type) {
    case 'ready':
      live = true;
      callStart = Date.now();
      timerId = setInterval(() => {
        const s = Math.floor((Date.now() - callStart) / 1000);
        els.timer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      }, 500);
      els.foot.textContent = `Voice model: ${msg.model} · voice: ${msg.voice} · Gemini Live API`;
      break;
    case 'audio':
      playChunk(msg.data);
      break;
    case 'transcript':
      addTranscript(msg.role, msg.text);
      break;
    case 'interrupted':
      stopPlayback();
      break;
    case 'tool':
      addActivity(msg);
      break;
    case 'summary':
      renderSummary(msg.summary);
      break;
    case 'notice':
      els.hint.textContent = msg.message;
      break;
    case 'error':
      showError(msg.message);
      endCall('Could not connect');
      break;
    case 'ended':
      endCall('Call ended');
      break;
  }
}

function endCall(statusText) {
  if (!inCall) return;
  inCall = false;
  live = false;
  muted = false;
  clearInterval(timerId);
  stopPlayback();
  if (ws) {
    ws.onclose = null;
    try {
      ws.close();
    } catch {}
    ws = null;
  }
  micStream?.getTracks().forEach((track) => track.stop());
  micCtx?.close();
  playCtx?.close();
  micStream = micCtx = playCtx = micAnalyser = outAnalyser = null;

  setStatus(statusText);
  els.orb.classList.remove('live', 'listening');
  els.callBtn.textContent = 'Call your KAM';
  els.callBtn.classList.remove('end');
  els.callBtn.disabled = false;
  els.muteBtn.hidden = true;
  els.language.disabled = els.voice.disabled = false;
  els.muteBtn.textContent = 'Mute';
}

els.callBtn.addEventListener('click', () => (inCall ? endCall('Call ended') : startCall()));
els.muteBtn.addEventListener('click', () => {
  muted = !muted;
  els.muteBtn.textContent = muted ? 'Unmute' : 'Mute';
});
