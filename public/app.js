// Browser client for the Sarvam-built agent.
//
// Sarvam's SDK captures the microphone, connects to the agent and plays its
// voice. This file only starts and stops the call and shows the transcript.
// The API key is not here: the SDK's first request goes to /api/sarvam/ on our
// server, which adds the key (see server.js).

import { ConversationAgent, BrowserAudioInterface, InteractionType, AgentState } from './vendor/sarvam-sdk.js';

const $ = (id) => document.getElementById(id);
const els = {
  orb: $('orb'),
  status: $('status'),
  timer: $('timer'),
  callBtn: $('callBtn'),
  muteBtn: $('muteBtn'),
  hint: $('hint'),
  transcript: $('transcript'),
  activity: $('activity'),
  summaryCard: $('summaryCard'),
  summary: $('summary'),
};
const hintText = els.hint.textContent;

let agent = null;
let config = null;
let timerId = null;
let lastBubble = null;
let lastRole = null;
let turns = [];
let session = null;
let startedAt = 0;
let lastActivityId = 0;
let pollId = null;

const setStatus = (text) => (els.status.textContent = text);

function showError(text) {
  els.hint.textContent = text;
  els.hint.classList.add('error');
}

// Sarvam can send the same turn several times as it grows. Update the bubble
// in that case and only start a new one when the speaker or the turn changes.
function addTranscript(role, text) {
  const content = (text || '').trim();
  if (!content) return;
  const who = role === 'user' ? 'seller' : 'kam';
  const previous = lastBubble?.querySelector('.body').textContent || '';
  const sameTurn = lastBubble && lastRole === who && (content.startsWith(previous) || previous.startsWith(content));
  if (sameTurn) {
    if (content.length >= previous.length) {
      lastBubble.querySelector('.body').textContent = content;
      turns[turns.length - 1].text = content;
    }
  } else {
    els.transcript.querySelector('.empty')?.remove();
    lastBubble = document.createElement('div');
    lastBubble.className = `bubble ${who}`;
    const label = document.createElement('span');
    label.className = 'who';
    label.textContent = who === 'seller' ? 'You' : 'Priya';
    const body = document.createElement('span');
    body.className = 'body';
    body.textContent = content;
    lastBubble.append(label, body);
    els.transcript.append(lastBubble);
    lastRole = who;
    turns.push({ role: who, text: content });
  }
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function onState(state) {
  const speaking = state === AgentState.SPEAKING;
  const listening = state === AgentState.LISTENING || state === AgentState.CONNECTED;
  els.orb.classList.toggle('listening', listening);
  if (speaking) setStatus('Priya is speaking');
  else if (listening) setStatus('Listening');
  else if (state === AgentState.CONNECTING) setStatus('Connecting…');
  else if (state === AgentState.ERROR) setStatus('Connection problem');
}

// --- What the agent did -----------------------------------------------------
// The agent's tools run on our server (see server.js). The page asks the server
// what has happened since the call began and shows it.
function showActivity(entry) {
  if (entry.kind === 'summary') return showSummary(entry.summary);
  els.activity.querySelector('.empty')?.remove();
  const li = document.createElement('li');
  li.className = `item ${entry.kind === 'action' ? 'action' : ''}`;
  const tag = document.createElement('div');
  tag.className = 'tag';
  tag.textContent = entry.kind === 'action' ? 'Action taken' : 'Data check';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = entry.title;
  li.append(tag, title);
  if (entry.detail) {
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = entry.detail;
    li.append(detail);
  }
  els.activity.append(li);
}

function showSummary(summary) {
  if (!summary) return;
  els.summary.innerHTML = '';
  const add = (heading, value) => {
    const items = Array.isArray(value) ? value : value ? [value] : [];
    if (!items.length) return;
    const h = document.createElement('h3');
    h.textContent = heading;
    els.summary.append(h);
    if (items.length === 1) {
      const p = document.createElement('p');
      p.textContent = items[0];
      els.summary.append(p);
    } else {
      const ul = document.createElement('ul');
      for (const item of items) {
        const li = document.createElement('li');
        li.textContent = item;
        ul.append(li);
      }
      els.summary.append(ul);
    }
  };
  add('Seller', summary.seller);
  add('Overview', summary.overview);
  add('Key issues', summary.issues);
  add('Recommendations', summary.recommendations);
  add('Next steps', summary.nextSteps);
  add('Outcome', summary.outcome);
  els.summaryCard.hidden = !els.summary.children.length;
}

async function pollActivity() {
  try {
    const query = `since=${startedAt}&after=${lastActivityId}&session=${encodeURIComponent(session)}`;
    const entries = await (await fetch(`/api/sarvam/activity?${query}`)).json();
    for (const entry of entries) {
      lastActivityId = Math.max(lastActivityId, entry.id);
      showActivity(entry);
    }
  } catch {}
}

function startPolling() {
  clearInterval(pollId);
  pollId = setInterval(pollActivity, 1500);
}

// The summary is sent by Sarvam just after the call ends, so keep checking
// for a little while, then stop.
function finishPolling() {
  const mine = pollId;
  setTimeout(() => {
    if (pollId === mine) {
      clearInterval(pollId);
      pollId = null;
      pollActivity();
    }
  }, 30000);
}

function saveCallLog() {
  if (!turns.length) return;
  const body = JSON.stringify({ turns, startedAt, seconds: Math.round((Date.now() - startedAt) / 1000) });
  fetch('/api/sarvam/call-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  turns = [];
}

function startTimer() {
  const began = Date.now();
  timerId = setInterval(() => {
    const s = Math.floor((Date.now() - began) / 1000);
    els.timer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}

function resetUi(status) {
  clearInterval(timerId);
  saveCallLog();
  finishPolling();
  timerId = null;
  agent = null;
  els.orb.classList.remove('live', 'listening');
  els.callBtn.textContent = 'Call your KAM';
  els.callBtn.classList.remove('end');
  els.callBtn.disabled = false;
  els.muteBtn.hidden = true;
  els.muteBtn.textContent = 'Mute';
  setStatus(status);
}

async function startCall() {
  els.callBtn.disabled = true;
  els.hint.classList.remove('error');
  els.hint.textContent = hintText;
  els.transcript.innerHTML = '';
  lastBubble = null;
  lastRole = null;
  turns = [];
  session = `web_${Date.now()}`;
  startedAt = Date.now();
  lastActivityId = 0;
  els.activity.innerHTML = '<li class="empty">Data checks and actions appear here during the call.</li>';
  els.summaryCard.hidden = true;
  setStatus('Connecting…');

  try {
    config ||= await (await fetch('/api/sarvam/config')).json();
    if (!config.hasKey) throw new Error('SARVAM_AGENT_API_KEY is not set on the server. Add it to .env and restart.');

    agent = new ConversationAgent({
      apiKey: '',
      baseUrl: `${location.origin}/api/sarvam/`,
      config: {
        org_id: config.org_id,
        workspace_id: config.workspace_id,
        app_id: config.app_id,
        user_identifier: session,
        user_identifier_type: 'custom',
        interaction_type: InteractionType.CALL,
        input_sample_rate: 16000,
        output_sample_rate: 16000,
        // Starting language. Empty leaves it to the agent's own setting in Sarvam.
        ...($('language').value ? { initial_language_name: $('language').value } : {}),
      },
      audioInterface: new BrowserAudioInterface(16000),
      transcriptCallback: async (msg) => addTranscript(msg.role, msg.content),
      // The fixed greeting may not arrive as a transcript. If the agent sends
      // text before anything is on screen, show it as Priya's first line.
      textCallback: async (msg) => {
        console.debug('[sarvam text]', msg);
        if (!lastBubble && msg.type === 'server.media.text') addTranscript('bot', msg.text);
      },
      eventCallback: async (event) => console.debug('[sarvam event]', event),
      stateCallback: async (state) => onState(state),
      endCallback: async () => {
        if (agent) resetUi('Call ended');
      },
    });

    await agent.start();
    const connected = await agent.waitForConnect(15);
    if (!connected) throw new Error('Timed out connecting to the agent. Check that it has a committed version.');

    els.orb.classList.add('live');
    els.callBtn.textContent = 'End call';
    els.callBtn.classList.add('end');
    els.callBtn.disabled = false;
    els.muteBtn.hidden = false;
    startTimer();
    startPolling();
    // Show the opening line (see the greeting note in server.js). Skipped when a
    // starting language is forced, because Sarvam then speaks a translation.
    if (!lastBubble && config.greeting && ['', 'English'].includes($('language').value)) addTranscript('bot', config.greeting);
  } catch (err) {
    console.error(err);
    const current = agent;
    resetUi('Could not start the call');
    try {
      await current?.stop();
    } catch {}
    showError(err?.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it and try again.' : err.message || String(err));
  }
}

async function endCall() {
  const current = agent;
  resetUi('Call ended');
  try {
    await current?.stop();
  } catch {}
}

els.callBtn.addEventListener('click', () => (agent ? endCall() : startCall()));

els.muteBtn.addEventListener('click', () => {
  if (!agent) return;
  if (agent.isMuted()) {
    agent.unmute();
    els.muteBtn.textContent = 'Mute';
  } else {
    agent.mute();
    els.muteBtn.textContent = 'Unmute';
  }
});
