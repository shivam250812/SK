// Smoke test.
//   1. Offline: checks the assumed mock data adds up to the given figures, and
//      runs every tool.
//   2. If GEMINI_API_KEY is set: opens a real Live session, asks for a greeting
//      and prints what the model said, so you know the key and model work
//      before opening the browser.

import 'dotenv/config';
import assert from 'node:assert/strict';
import { GoogleGenAI, Modality } from '@google/genai';
import * as data from '../kam/data.js';
import { runTool, createCallState, functionDeclarations } from '../kam/tools.js';
import { buildSystemInstruction, greetingCue } from '../kam/prompt.js';

// ---- 1. data consistency ----
const { metrics: m } = data;
const groups = [data.otherNewlyOutOfStock, data.alreadyOutOfStockLastMonth, data.inStockProducts];
const best = data.bestsellersOutOfStock;
const last = best.reduce((a, p) => a + p.ordersLastMonth, 0) + groups.reduce((a, g) => a + g.ordersLastMonth, 0);
const now = best.reduce((a, p) => a + p.ordersThisMonth, 0) + groups.reduce((a, g) => a + g.ordersThisMonth, 0);
assert.equal(last, m.lastMonth.orders, 'last month orders add up');
assert.equal(now, m.thisMonth.orders, 'this month orders add up');
assert.equal(m.lastMonth.orders * m.lastMonth.asp, m.lastMonth.sales, 'last month sales = orders x ASP');
assert.equal(m.thisMonth.orders * m.thisMonth.asp, m.thisMonth.sales, 'this month sales = orders x ASP');
assert.equal(best.length + data.otherNewlyOutOfStock.count + data.alreadyOutOfStockLastMonth.count, m.thisMonth.oosProducts);
assert.equal(data.alreadyOutOfStockLastMonth.count, m.lastMonth.oosProducts);
assert.equal(m.thisMonth.oosProducts + data.inStockProducts.count, data.seller.activeListings);
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
assert.equal(total(data.cancellations.lastMonth), Math.round((m.lastMonth.orders * m.lastMonth.cancellationRate) / 100));
assert.equal(total(data.cancellations.thisMonth), Math.round((m.thisMonth.orders * m.thisMonth.cancellationRate) / 100));
console.log('OK  mock data adds up to the given figures');

// ---- 2. tools ----
const spoken = () => {
  const st = createCallState();
  st.noteSellerSpoke();
  return st;
};
assert.equal(runTool(createCallState(), 'get_account_snapshot').kind, 'held', 'nothing runs before the seller speaks');
const asked = spoken();
asked.noteAgentSaid('Shall I switch it on?');
assert.equal(runTool(asked, 'enable_inventory_safeguard').kind, 'held', 'actions wait for an answer');
assert.equal(asked.actions.length, 0);
const early = spoken();
runTool(early, 'create_restock_plan', {});
assert.equal(runTool(early, 'send_call_summary', {}).kind, 'held', 'summary waits for the seller');
const state = spoken();
for (const decl of functionDeclarations) {
  const args = decl.name === 'send_call_summary' ? { main_issues: ['a'], recommendations: ['b'], next_steps: ['c'] } : { reason: 'test' };
  if (decl.name === 'send_call_summary') {
    state.noteAgentSaid('Done.');
    state.noteSellerSpoke('No, that is all.');
  }
  const out = runTool(state, decl.name, args);
  assert.notEqual(out.kind, 'error', `${decl.name} runs`);
}
const stock = runTool(spoken(), 'get_stockout_analysis').result;
const plan = runTool(spoken(), 'create_restock_plan', { top_n: '4' }).result;
console.log(`OK  all ${functionDeclarations.length} tools run, guards hold early actions`);
console.log(`    bestsellers explain ${stock.bestsellerShareOfTotalDropPercent}% of the drop (${stock.bestsellerOrdersLost} orders, Rs ${stock.bestsellerRevenueLostRupees})`);
console.log(`    restock plan: ${plan.items.map((i) => `${i.name} x${i.restockUnits}`).join(', ')}`);

// ---- 3. live session (needs a key) ----
const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!key) {
  console.log('SKIP live check: GEMINI_API_KEY is not set');
  process.exit(0);
}

const models = [process.env.GEMINI_LIVE_MODEL, 'gemini-3.8-live', 'gemini-3.1-flash-live-preview', 'gemini-2.5-flash-live-preview'].filter(
  (v, i, all) => v && all.indexOf(v) === i,
);
const ai = new GoogleGenAI({ apiKey: key });

function tryModel(model) {
  return new Promise((resolve) => {
    let said = '';
    let audioBytes = 0;
    let session;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        session?.close();
      } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: audioBytes > 0, said, audioBytes, error: 'timed out' }), 25000);
    ai.live
      .connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: buildSystemInstruction('auto'),
          tools: [{ functionDeclarations }],
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {},
          onmessage: (msg) => {
            const c = msg.serverContent;
            for (const part of c?.modelTurn?.parts || []) if (part.inlineData?.data) audioBytes += part.inlineData.data.length;
            if (c?.outputTranscription?.text) said += c.outputTranscription.text;
            if (c?.turnComplete) finish({ ok: audioBytes > 0, said, audioBytes });
          },
          onerror: (e) => finish({ ok: false, error: e?.message || 'connection error' }),
          onclose: (e) => finish({ ok: audioBytes > 0, said, audioBytes, error: e?.reason || 'closed' }),
        },
      })
      .then((s) => {
        session = s;
        s.sendRealtimeInput({ text: greetingCue });
      })
      .catch((err) => finish({ ok: false, error: err.message }));
  });
}

let passed = false;
for (const model of models) {
  const r = await tryModel(model);
  if (r.ok) {
    console.log(`OK  live session on ${model}: received audio, model said: "${r.said.trim()}"`);
    passed = true;
    break;
  }
  console.log(`FAIL ${model}: ${r.error}`);
}
process.exit(passed ? 0 : 1);
