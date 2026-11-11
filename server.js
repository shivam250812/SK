// Virtual KAM server.
//
// Browser  <-- WebSocket -->  this server  <-- Gemini Live API -->  model
//
// The browser streams microphone audio here. This server relays it to the
// Gemini Live session, relays the model's speech back, and runs the tools the
// model calls. The API key and the tool logic never leave the server.

import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

import { seller, metrics } from './kam/data.js';
import { buildSystemInstruction, greetingCue, KAM_NAME } from './kam/prompt.js';
import { functionDeclarations, runTool, createCallState } from './kam/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const VOICES = ['Sulafat', 'Aoede', 'Achernar', 'Leda', 'Vindemiatrix', 'Kore'];
const DEFAULT_VOICE = process.env.GEMINI_VOICE || VOICES[0];
const LOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'logs');

// Tried in order until one accepts the session. Set GEMINI_LIVE_MODEL to pin one.
const MODELS = [
  process.env.GEMINI_LIVE_MODEL,
  'gemini-3.8-live',
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-live-preview',
].filter((m, i, all) => m && all.indexOf(m) === i);

const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

const app = express();
// The Sarvam agent page is the home page once its key is set. The Gemini
// version stays available at /index.html.
app.get('/', (_req, res, next) =>
  process.env.SARVAM_AGENT_API_KEY || process.env.SARVAM_API_KEY ? res.redirect('/sarvam.html') : next(),
);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/seller', (_req, res) => res.json({ seller, metrics, kamName: KAM_NAME, voices: VOICES, defaultVoice: DEFAULT_VOICE }));
app.get('/api/health', (_req, res) => res.json({ ok: true, hasKey: Boolean(API_KEY) }));

// --- Sarvam agent (public/sarvam.html) --------------------------------------
// The page talks to the agent built in Sarvam's dashboard through Sarvam's
// browser SDK. The SDK first asks for a one-time signed WebSocket address; that
// request comes here so the Sarvam API key is added on the server and never
// reaches the browser. The agent IDs are fixed here, whatever the page sends.
const SARVAM = {
  // The agent service needs its own key (Samvaad Settings > API Key). The sk_
  // key for Sarvam's model APIs is rejected with "Invalid API key format".
  key: process.env.SARVAM_AGENT_API_KEY || process.env.SARVAM_API_KEY || '',
  org: process.env.SARVAM_ORG_ID || '01a1c4b1-c611-7933-94b0-81837d7bb68b',
  workspace: process.env.SARVAM_WORKSPACE_ID || '01a1c4b1-c617-71a2-9ce2-1fa22b300779',
  app: process.env.SARVAM_APP_ID || 'Conversatio-c85245fc-bf92',
  runtime: 'https://apps.sarvam.ai/api/app-runtime/',
};

app.get('/api/sarvam/config', (_req, res) =>
  res.json({ hasKey: Boolean(SARVAM.key), org_id: SARVAM.org, workspace_id: SARVAM.workspace, app_id: SARVAM.app }),
);

app.get('/api/sarvam/orgs/:org/workspaces/:workspace/apps/:app/url', async (req, res) => {
  if (!SARVAM.key) return res.status(401).json({ error: 'SARVAM_AGENT_API_KEY is not set on the server.' });
  const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  const url = `${SARVAM.runtime}orgs/${SARVAM.org}/workspaces/${SARVAM.workspace}/apps/${encodeURIComponent(SARVAM.app)}/url${query}`;
  try {
    const upstream = await fetch(url, { headers: { 'X-API-Key': SARVAM.key } });
    const body = await upstream.text();
    if (!upstream.ok) console.log(`Sarvam signed-URL request failed: ${upstream.status} ${body.slice(0, 300)}`);
    res.status(upstream.status).type('application/json').send(body);
  } catch (err) {
    console.log(`Sarvam signed-URL request error: ${err.message}`);
    res.status(502).json({ error: 'Could not reach Sarvam.' });
  }
});

// --- Tools the Sarvam agent calls ---------------------------------------------
// Configured in Sarvam as API tools pointing at this server's public address:
//   get_seller_data        GET  /api/tools/seller-data    during the call
//   log_seller_team_note   POST /api/tools/note           during the call
//   schedule_followup      POST /api/tools/followup       during the call
//   send_call_summary      POST /api/tools/call-summary   automatically at call end
// The numbers and their differences are computed here, so the model never does
// arithmetic. Everything a tool does is kept in `activity`, which the page
// polls to show what the agent did, and appended to logs/sarvam-actions.jsonl.
const TOOL_TOKEN = process.env.SARVAM_TOOL_TOKEN || '';
const activity = [];
let activityId = 0;

function record(kind, title, detail, extra = {}) {
  const entry = { id: ++activityId, ts: Date.now(), kind, title, detail, ...extra };
  activity.push(entry);
  if (activity.length > 200) activity.shift();
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'sarvam-actions.jsonl'), JSON.stringify(entry) + '\n');
  } catch {}
  return entry;
}

const clip = (value, max = 600) => (value == null ? '' : String(value).trim().slice(0, max));
// Accepts a real list, or one string with items separated by new lines, semicolons or bullets.
const toList = (value) =>
  (Array.isArray(value) ? value : String(value ?? '').split(/\n|;|•/))
    .map((item) => clip(item, 300).replace(/^[-*\d.)\s]+/, ''))
    .filter(Boolean)
    .slice(0, 6);

const tools = express.Router();
tools.use(express.json({ limit: '200kb' }));
tools.use((req, res, next) => {
  if (TOOL_TOKEN && req.get('authorization') !== `Bearer ${TOOL_TOKEN}`) return res.status(401).json({ error: 'unauthorized' });
  next();
});
const sessionOf = (req) => clip(req.body?.session || req.query.session, 80) || null;

tools.get('/seller-data', (req, res) => {
  const { lastMonth: last, thisMonth: now } = metrics;
  record('data', 'Looked up the store data', 'Sales, orders, cancellations, selling price and out-of-stock products, last month and this month.', {
    session: sessionOf(req),
  });
  res.json({
    period: 'last month compared with this month',
    sales_last_month: last.sales,
    sales_this_month: now.sales,
    sales_drop_rupees: last.sales - now.sales,
    sales_drop_percent: Math.round(((last.sales - now.sales) / last.sales) * 1000) / 10,
    orders_last_month: last.orders,
    orders_this_month: now.orders,
    orders_lost: last.orders - now.orders,
    cancellation_rate_last_month_percent: last.cancellationRate,
    cancellation_rate_this_month_percent: now.cancellationRate,
    average_selling_price_last_month: last.asp,
    average_selling_price_this_month: now.asp,
    price_changed: last.asp !== now.asp,
    out_of_stock_products_last_month: last.oosProducts,
    out_of_stock_products_this_month: now.oosProducts,
    newly_out_of_stock_products: now.oosProducts - last.oosProducts,
    not_available: 'There is no split by category or product, and no reason for why stock ran out. Ask the seller.',
  });
});

tools.post('/note', (req, res) => {
  const note = clip(req.body?.note);
  if (!note) return res.status(400).json({ error: 'note is required' });
  const entry = record('action', 'Note logged for the seller team', note, { session: sessionOf(req) });
  res.json({ status: 'logged', reference: `NOTE-${entry.id}` });
});

tools.post('/followup', (req, res) => {
  const days = Math.min(Math.max(parseInt(req.body?.in_days, 10) || 7, 1), 30);
  const topic = clip(req.body?.topic, 200) || 'Check stock and cancellations';
  const when = new Date(Date.now() + days * 86400000);
  const options = { timeZone: 'Asia/Kolkata' };
  const day = when.toLocaleDateString('en-IN', { ...options, weekday: 'long' });
  const date = when.toLocaleDateString('en-IN', { ...options, day: 'numeric', month: 'long' });
  const entry = record('action', `Follow-up call booked for ${day}, ${date}`, topic, { session: sessionOf(req) });
  res.json({ status: 'booked', day, date, say_it_as: `${day}, ${date}`, reference: `FUP-${entry.id}` });
});

tools.post('/call-summary', (req, res) => {
  const body = req.body || {};
  const summary = {
    seller: [clip(body.seller_name, 80), clip(body.store_name, 80)].filter((v) => v && !v.startsWith('<')).join(', '),
    outcome: clip(body.call_outcome, 120),
    overview: clip(body.call_summary, 900),
    issues: toList(body.key_issues),
    recommendations: toList(body.recommendations),
    nextSteps: toList(body.next_steps),
  };
  record('summary', 'Call summary saved', summary.overview, { session: sessionOf(req), summary });
  res.json({ status: 'saved' });
});

app.use('/api/tools', tools);

// What the tools did since a call began, for the page to show.
app.get('/api/sarvam/activity', (req, res) => {
  const since = Number(req.query.since) || 0;
  const after = Number(req.query.after) || 0;
  const session = clip(req.query.session, 80);
  res.json(activity.filter((e) => e.id > after && e.ts >= since && (!e.session || !session || e.session === session)));
});

// The page sends the transcript when a call ends, so every call leaves a record.
app.post('/api/sarvam/call-log', express.json({ limit: '500kb' }), (req, res) => {
  const turns = Array.isArray(req.body?.turns) ? req.body.turns.slice(0, 400) : [];
  if (!turns.length) return res.json({ saved: false });
  const since = Number(req.body.startedAt) || 0;
  const lines = [`[sarvam call: started=${new Date(since || Date.now()).toISOString()} seconds=${Number(req.body.seconds) || 0}]`];
  for (const t of turns) lines.push(`${t.role === 'seller' ? 'SELLER' : 'PRIYA'}: ${clip(t.text, 2000)}`);
  for (const e of activity.filter((e) => e.ts >= since)) lines.push(`[${e.kind}: ${e.title}${e.detail ? ` | ${e.detail}` : ''}]`);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(LOG_DIR, `sarvam-call-${stamp}.txt`), lines.join('\n') + '\n');
    res.json({ saved: true });
  } catch {
    res.json({ saved: false });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Open a Live session on one model. Resolves once the model confirms setup,
// rejects if the connection fails or closes before that.
function connectModel(model, language, voice, handlers) {
  return new Promise((resolve, reject) => {
    let session = null;
    let setupDone = false;
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      if (err) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      } else if (session && setupDone) {
        settled = true;
        clearTimeout(timer);
        resolve(session);
      }
    };
    const timer = setTimeout(() => {
      try {
        session?.close();
      } catch {}
      finish(new Error('timed out waiting for the model'));
    }, 12000);

    ai.live
      .connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: buildSystemInstruction(language),
          tools: [{ functionDeclarations }],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {},
          onmessage: (message) => {
            if (message.setupComplete) {
              setupDone = true;
              finish();
              return;
            }
            if (settled) handlers.onMessage(message);
          },
          onerror: (event) => {
            const err = new Error(event?.message || event?.error?.message || 'connection error');
            if (settled) handlers.onError(err);
            else finish(err);
          },
          onclose: (event) => {
            if (settled) handlers.onClose(event?.reason || '');
            else finish(new Error(event?.reason || 'connection closed during setup'));
          },
        },
      })
      .then((s) => {
        session = s;
        finish();
      })
      .catch((err) => finish(err));
  });
}

wss.on('connection', (client) => {
  const state = createCallState();
  let session = null;
  let starting = false;
  let micRate = 16000;
  let language = 'auto';
  let voice = DEFAULT_VOICE;

  // Each call is saved to logs/ so conversations can be reviewed afterwards.
  const lines = [];
  let current = null;
  const flush = () => {
    if (current?.text.trim()) lines.push(`${current.role}: ${current.text.trim()}`);
    current = null;
  };
  const log = (line) => {
    flush();
    lines.push(`[${line}]`);
  };
  const logSpeech = (role, text) => {
    if (current?.role !== role) {
      flush();
      current = { role, text: '' };
    }
    current.text += text;
  };
  const saveLog = () => {
    flush();
    if (lines.length < 2) return;
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(LOG_DIR, `call-${stamp}.txt`), lines.join('\n') + '\n');
    } catch (err) {
      console.warn('could not save call log:', err.message);
    }
    lines.length = 0;
  };

  const send = (payload) => {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(payload));
  };

  const onMessage = (message) => {
    const content = message.serverContent;
    if (content) {
      // After a held action the model sometimes repeats its question. Drop
      // that audio so the seller hears the question once.
      const muted = state.muteUntilTurnEnds;
      if (content.turnComplete || content.inputTranscription?.text) state.muteUntilTurnEnds = false;
      if (muted && !content.inputTranscription?.text) {
        if (content.interrupted) send({ type: 'interrupted' });
        if (content.turnComplete) send({ type: 'turn_complete' });
        return handleToolCalls(message);
      }
      for (const part of content.modelTurn?.parts || []) {
        if (part.inlineData?.data && !part.thought) send({ type: 'audio', data: part.inlineData.data });
      }
      if (content.inputTranscription?.text) state.noteSellerSpoke(content.inputTranscription.text);
      if (content.outputTranscription?.text) state.noteAgentSaid(content.outputTranscription.text);
      if (content.inputTranscription?.text) logSpeech('SELLER', content.inputTranscription.text);
      if (content.outputTranscription?.text) logSpeech('PRIYA', content.outputTranscription.text);
      if (content.interrupted) log('seller interrupted');
      if (content.inputTranscription?.text) send({ type: 'transcript', role: 'seller', text: content.inputTranscription.text });
      if (content.outputTranscription?.text) send({ type: 'transcript', role: 'kam', text: content.outputTranscription.text });
      if (content.interrupted) send({ type: 'interrupted' });
      if (content.turnComplete) send({ type: 'turn_complete' });
    }

    handleToolCalls(message);
  };

  const handleToolCalls = (message) => {
    if (message.toolCall?.functionCalls?.length) {
      const functionResponses = message.toolCall.functionCalls.map((call) => {
        const out = runTool(state, call.name, call.args);
        if (out.kind === 'held' && out.mute) state.muteUntilTurnEnds = true;
        console.log(`[tool${out.kind === 'held' ? ' held' : ''}] ${call.name}(${JSON.stringify(call.args || {})})`);
        log(`tool${out.kind === 'held' ? ' HELD' : ''}: ${call.name} ${JSON.stringify(call.args || {})}`);
        send({ type: 'tool', name: call.name, kind: out.kind, label: out.label, action: out.action || null });
        if (call.name === 'send_call_summary' && state.summary) send({ type: 'summary', summary: state.summary });
        return { id: call.id, name: call.name, response: { result: out.result } };
      });
      session?.sendToolResponse({ functionResponses });
    }

    if (message.goAway) send({ type: 'notice', message: 'The call is close to its time limit.' });
  };

  async function startCall() {
    if (!ai) {
      send({ type: 'error', message: 'GEMINI_API_KEY is not set on the server. Add it to .env and restart.' });
      return;
    }
    const failures = [];
    for (const model of MODELS) {
      try {
        session = await connectModel(model, language, voice, {
          onMessage,
          onError: (err) => send({ type: 'error', message: err.message }),
          onClose: (reason) => {
            session = null;
            send({ type: 'ended', reason });
          },
        });
        console.log(`[call] connected on ${model}`);
        send({ type: 'ready', model, voice });
        log(`call started: model=${model} voice=${voice} language=${language}`);
        session.sendRealtimeInput({ text: greetingCue });
        return;
      } catch (err) {
        console.warn(`[call] ${model} failed: ${err.message}`);
        failures.push(`${model}: ${err.message}`);
      }
    }
    send({ type: 'error', message: `Could not start a voice session. ${failures.join(' | ')}` });
  }

  client.on('message', (data, isBinary) => {
    if (isBinary) {
      // Raw 16-bit PCM from the microphone.
      if (session) {
        session.sendRealtimeInput({
          audio: { data: Buffer.from(data).toString('base64'), mimeType: `audio/pcm;rate=${micRate}` },
        });
      }
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    // The browser heard the seller's voice on the microphone. Backs up the
    // transcription signal for the listen-first guard.
    if (msg.type === 'voice') state.sellerHasSpoken = true;
    if (msg.type === 'start' && !session && !starting) {
      starting = true;
      micRate = Number(msg.sampleRate) || 16000;
      language = ['auto', 'english', 'hinglish'].includes(msg.language) ? msg.language : 'auto';
      voice = VOICES.includes(msg.voice) ? msg.voice : DEFAULT_VOICE;
      state.languageMode = language;
      if (language !== 'auto') state.sellerLanguage = language;
      startCall().finally(() => {
        starting = false;
        if (client.readyState !== client.OPEN) session?.close();
      });
    }
  });

  client.on('close', () => {
    saveLog();
    try {
      session?.close();
    } catch {}
    session = null;
  });
});

server.listen(PORT, () => {
  console.log(`Virtual KAM running at http://localhost:${PORT}`);
  if (!API_KEY) console.log('GEMINI_API_KEY is not set. The page will load, but calls will not connect.');
  console.log(`Sarvam agent page: http://localhost:${PORT}/sarvam.html${SARVAM.key ? '' : ' (SARVAM_AGENT_API_KEY is not set, calls will not connect)'}`);
});
