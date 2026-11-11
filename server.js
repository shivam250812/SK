// Virtual KAM server.
//
// The voice agent itself runs on Sarvam. This server does three small jobs:
//   1. serves the page in public/
//   2. starts calls: fetches a one-time connection address from Sarvam, so the
//      API key never reaches the browser
//   3. runs the agent's tools (seller data, note, follow-up, call summary) and
//      tells the page what the agent did

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { metrics } from './data.js';
import { saveCall, listCalls, storeKind } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const LOG_DIR = path.join(__dirname, 'logs');
// The sample data describes one seller, so every call belongs to this seller.
const SELLER_ID = process.env.SELLER_ID || 'demo-seller';

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// --- Starting a call ---------------------------------------------------------
// The page talks to the agent built in Sarvam's dashboard through Sarvam's
// browser SDK. The SDK first asks for a one-time signed WebSocket address; that
// request comes here so the Sarvam API key is added on the server and never
// reaches the browser. The agent IDs are fixed here, whatever the page sends.
const SARVAM = {
  // The agent service needs its own key (Samvaad Settings > API Key). The sk_
  // key for Sarvam's model APIs is rejected with "Invalid API key format".
  key: process.env.SARVAM_AGENT_API_KEY || '',
  org: process.env.SARVAM_ORG_ID || '019f7ba6-60c2-70f1-a03e-82550feba788',
  workspace: process.env.SARVAM_WORKSPACE_ID || '019f7ba6-60d2-7572-b115-838d575c1676',
  app: process.env.SARVAM_APP_ID || 'snapdeal-0e571f18-d5c1',
  runtime: 'https://apps.sarvam.ai/api/app-runtime/',
  // The agent's fixed opening line, as set in Sarvam. Sarvam speaks it but does
  // not send it in the transcript, so the page shows this text. Keep them the same.
  greeting:
    process.env.SARVAM_GREETING ||
    'Welcome to Snapdeal Seller Care. I am Priya, your virtual Key Account Manager. How shall I help you today?',
};

app.get('/api/sarvam/config', (_req, res) =>
  res.json({ hasKey: Boolean(SARVAM.key), org_id: SARVAM.org, workspace_id: SARVAM.workspace, app_id: SARVAM.app, greeting: SARVAM.greeting }),
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
// Values the agent writes when it has nothing to say.
const EMPTY = /^(none|null|n\/?a|nil|not applicable|-+)\.?$/i;
const toList = (value) =>
  (Array.isArray(value) ? value : String(value ?? '').split(/\n|;|•/))
    .map((item) => clip(item, 300).replace(/^[-*\d.)\s]+/, ''))
    .filter((item) => item && !EMPTY.test(item))
    .slice(0, 6);

const tools = express.Router();
tools.use(express.json({ limit: '200kb' }));
tools.use((req, res, next) => {
  if (TOOL_TOKEN && req.get('authorization') !== `Bearer ${TOOL_TOKEN}`) return res.status(401).json({ error: 'unauthorized' });
  next();
});
// Sarvam may send a tool's parameters in the address, in the body, or nested one
// level down in the body. Read all three, so the form's layout does not matter.
const lastCalls = [];
function input(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const nested = ['parameters', 'params', 'arguments', 'args', 'data', 'body', 'variables', 'agent_variables']
    .map((key) => body[key])
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  return Object.assign({}, req.query, body, ...nested);
}
tools.use((req, _res, next) => {
  req.input = input(req);
  // Shape of recent tool calls (names and sizes only), to help when connecting tools.
  const sizes = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, typeof v === 'object' ? 'object' : String(v).length]));
  lastCalls.push({ at: new Date().toISOString(), method: req.method, path: req.path, query: sizes(req.query), body: sizes(req.body) });
  if (lastCalls.length > 20) lastCalls.shift();
  next();
});
tools.get('/recent-calls', (_req, res) => res.json(lastCalls));
const sessionOf = (req) => clip(req.input.session, 80) || null;

// What the agent is told about the seller's last call, so it can follow up on it.
async function previousCall() {
  try {
    // The last call that ended with agreed steps. Calls that were cut short have
    // nothing to follow up on, and their summaries can hold half-heard numbers.
    const recent = await listCalls(SELLER_ID, 5);
    const last = recent.find((call) => call.nextSteps.some((step) => !EMPTY.test(step)));
    if (!last) return { had_previous_call: false };
    const days = Math.floor((Date.now() - new Date(last.at).getTime()) / 86400000);
    return {
      had_previous_call: true,
      previous_call_when: days === 0 ? 'earlier today' : days === 1 ? 'yesterday' : `${days} days ago`,
      previous_call_agreed_steps: last.nextSteps.filter((step) => !EMPTY.test(step)).join('; '),
      previous_call_actions: last.actions.join('; '),
    };
  } catch (err) {
    console.log(`Could not read call history: ${err.message}`);
    return { had_previous_call: false };
  }
}

tools.get('/seller-data', async (req, res) => {
  const { lastMonth: last, thisMonth: now } = metrics;
  const previous = await previousCall();
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
    ...previous,
  });
});

tools.post('/note', (req, res) => {
  const note = clip(req.input.note);
  if (!note) return res.status(400).json({ error: 'note is required' });
  const entry = record('action', 'Note logged for the seller team', note, { session: sessionOf(req) });
  res.json({ status: 'logged', reference: `NOTE-${entry.id}` });
});

tools.post('/followup', (req, res) => {
  const days = Math.min(Math.max(parseInt(req.input.in_days, 10) || 7, 1), 30);
  const topic = clip(req.input.topic, 200) || 'Check stock and cancellations';
  const when = new Date(Date.now() + days * 86400000);
  const options = { timeZone: 'Asia/Kolkata' };
  const day = when.toLocaleDateString('en-IN', { ...options, weekday: 'long' });
  const date = when.toLocaleDateString('en-IN', { ...options, day: 'numeric', month: 'long' });
  const entry = record('action', `Follow-up call booked for ${day}, ${date}`, topic, { session: sessionOf(req) });
  res.json({ status: 'booked', day, date, say_it_as: `${day}, ${date}`, reference: `FUP-${entry.id}` });
});

tools.post('/call-summary', (req, res) => {
  const body = req.input;
  const summary = {
    seller: [clip(body.seller_name, 80), clip(body.store_name, 80)].filter((v) => v && !v.startsWith('<')).join(', '),
    outcome: clip(body.call_outcome, 120),
    overview: clip(body.call_summary, 900),
    issues: toList(body.key_issues),
    recommendations: toList(body.recommendations),
    nextSteps: toList(body.next_steps),
  };
  // An empty summary means the agent's variables were not filled. Do not show a blank card.
  const hasContent = summary.overview || summary.issues.length || summary.recommendations.length || summary.nextSteps.length;
  if (hasContent) {
    record('summary', 'Call summary saved', summary.overview, { session: sessionOf(req), summary });
    // Keep the call in the history, with the actions taken since its data lookup.
    const start = activity.map((e) => e.kind).lastIndexOf('data');
    const actions = activity.slice(Math.max(start, 0)).filter((e) => e.kind === 'action').map((e) => (e.detail ? `${e.title}: ${e.detail}` : e.title));
    saveCall(SELLER_ID, { ...summary, actions }).catch((err) => console.log(`Could not save call history: ${err.message}`));
  }
  res.json({ status: hasContent ? 'saved' : 'empty' });
});

app.use('/api/tools', tools);

// The seller's past calls, most recent first, for the page to show.
app.get('/api/sarvam/history', async (_req, res) => {
  try {
    res.json(await listCalls(SELLER_ID, 5));
  } catch (err) {
    console.log(`Could not read call history: ${err.message}`);
    res.json([]);
  }
});

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

app.listen(PORT, () => {
  console.log(`Virtual KAM running at http://localhost:${PORT} (call history: ${storeKind})`);
  if (!SARVAM.key) console.log('SARVAM_AGENT_API_KEY is not set. The page will load, but calls will not connect.');
});
