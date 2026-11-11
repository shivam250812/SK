// Tools the voice agent can call.
//
// Two kinds:
//   analysis - read the seller's data and return numbers computed here in code,
//              so the model never does arithmetic or invents a figure.
//   action   - (mock) things the agent does on the seller's behalf. Each one is
//              recorded on the call and shown live in the browser.

import {
  seller,
  metrics,
  bestsellersOutOfStock,
  otherNewlyOutOfStock,
  alreadyOutOfStockLastMonth,
  inStockProducts,
  cancellations,
} from './data.js';

const pct = (from, to) => Math.round(((to - from) / from) * 1000) / 10;
const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);
const int = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

// Works out which language the seller is speaking from the live transcript.
const HINDI_WORDS = new Set(
  ('hai hain nahi nahin kya kyun kyon kaise mera meri mere mujhe aap aapka tum haan han ji kar karo kardo kiya gaya gayi raha rahi ho hoon tha thi ka ki ke ko mein aur ' +
    'lekin bhi toh ab abhi bahut thoda maal paisa dukaan mahine mahina hafte kab kahan kuch koi sab yeh ye woh wo theek thik accha achha bata batao chahiye sakta sakti pata chal').split(' '),
);

export function detectLanguage(text) {
  if (/[\u0900-\u097F]/.test(text)) return 'hinglish';
  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  if (words.length === 0) return null;
  const hindi = words.filter((w) => HINDI_WORDS.has(w)).length;
  if (hindi >= 2 || (words.length <= 3 && hindi >= 1)) return 'hinglish';
  return words.length >= 2 ? 'english' : null;
}

const languageHint = {
  hinglish: 'The seller is speaking Hindi. Say all of this to them in Hinglish, not English.',
  english: 'The seller is speaking English. Reply in English.',
};

export function createCallState() {
  return {
    actions: [],
    summary: null,
    // What the agent has said since the seller last spoke. Used by the consent guard.
    saidSinceSeller: '',
    // Set when an action is held, so the server can drop any repeated speech.
    muteUntilTurnEnds: false,
    noteAgentSaid(text) {
      this.saidSinceSeller += text;
    },
    sellerHasSpoken: false,
    // 'auto' follows the seller; 'english' and 'hinglish' are fixed for the call.
    languageMode: 'auto',
    sellerLanguage: 'english',
    sellerTurnText: '',
    // Seller turns since the agent last changed something. The summary guard uses it.
    sellerTurnsSinceAction: 0,
    noteSellerSpoke(text = '') {
      if (this.saidSinceSeller || !this.sellerHasSpoken) {
        this.sellerTurnText = '';
        this.sellerTurnsSinceAction++;
      }
      this.sellerHasSpoken = true;
      this.saidSinceSeller = '';
      this.sellerTurnText += text;
      const detected = this.languageMode === 'auto' ? detectLanguage(this.sellerTurnText) : this.languageMode;
      if (detected) this.sellerLanguage = detected;
    },
  };
}

// ---------- analysis ----------

function getAccountSnapshot() {
  const l = metrics.lastMonth;
  const t = metrics.thisMonth;
  const cancelledLast = Math.round((l.orders * l.cancellationRate) / 100);
  const cancelledThis = Math.round((t.orders * t.cancellationRate) / 100);
  return {
    seller: { name: seller.name, store: seller.store, category: seller.category, city: seller.city },
    lastMonth: l,
    thisMonth: t,
    headline: `Sales fell by ${l.sales - t.sales} rupees, from ${l.sales} to ${t.sales}. Orders fell from ${l.orders} to ${t.orders}.`,
    changes: {
      salesDropRupees: l.sales - t.sales,
      salesChangePercent: pct(l.sales, t.sales),
      ordersLost: l.orders - t.orders,
      ordersChangePercent: pct(l.orders, t.orders),
      averageSellingPriceChange: t.asp - l.asp,
      cancellationRateChangePoints: t.cancellationRate - l.cancellationRate,
      outOfStockProductsAdded: t.oosProducts - l.oosProducts,
    },
    fulfilledOrders: {
      lastMonth: l.orders - cancelledLast,
      thisMonth: t.orders - cancelledThis,
      changePercent: pct(l.orders - cancelledLast, t.orders - cancelledThis),
    },
    reading:
      'Average selling price is unchanged, so this is not a pricing problem. Sales fell because orders fell. ' +
      'Out-of-stock products more than tripled and the cancellation rate nearly doubled. Check stock-outs and cancellations next.',
  };
}

function getStockoutAnalysis() {
  const asp = metrics.thisMonth.asp;
  const totalOrdersLost = metrics.lastMonth.orders - metrics.thisMonth.orders;
  const bestsellers = bestsellersOutOfStock.map((p) => ({
    sku: p.sku,
    name: p.name,
    ordersLastMonth: p.ordersLastMonth,
    ordersThisMonth: p.ordersThisMonth,
    ordersLost: p.ordersLastMonth - p.ordersThisMonth,
    daysOutOfStock: p.daysOutOfStock,
  }));
  const bestsellerLoss = bestsellers.reduce((a, p) => a + p.ordersLost, 0);
  const otherLoss = otherNewlyOutOfStock.ordersLastMonth - otherNewlyOutOfStock.ordersThisMonth;
  return {
    outOfStockProductsNow: metrics.thisMonth.oosProducts,
    alreadyOutOfStockLastMonth: alreadyOutOfStockLastMonth.count,
    newlyOutOfStockThisMonth: bestsellers.length + otherNewlyOutOfStock.count,
    bestsellersOutOfStock: bestsellers,
    bestsellerOrdersLost: bestsellerLoss,
    bestsellerRevenueLostRupees: bestsellerLoss * asp,
    bestsellerShareOfTotalDropPercent: Math.round((bestsellerLoss / totalOrdersLost) * 100),
    otherNewlyOutOfStock: { products: otherNewlyOutOfStock.count, ordersLost: otherLoss },
    allStockoutsOrdersLost: bestsellerLoss + otherLoss,
    allStockoutsRevenueLostRupees: (bestsellerLoss + otherLoss) * asp,
    totalSalesDropRupees: metrics.lastMonth.sales - metrics.thisMonth.sales,
    productsStillInStock: {
      products: inStockProducts.count,
      ordersLastMonth: inStockProducts.ordersLastMonth,
      ordersThisMonth: inStockProducts.ordersThisMonth,
    },
    reading:
      'Products that stayed in stock sold slightly more than last month, so customer demand is healthy. ' +
      'The whole drop comes from products that ran out, and four bestsellers explain most of it.',
    dataBasis: 'Product-level figures are assumed mock data, built to add up to the given totals.',
  };
}

function getCancellationBreakdown() {
  const l = cancellations.lastMonth;
  const t = cancellations.thisMonth;
  return {
    cancelledOrders: { lastMonth: sum(l), thisMonth: sum(t) },
    lastMonth: l,
    thisMonth: t,
    reading:
      'Customer cancellations and failed deliveries both went down. Cancellations by the seller for lack of stock ' +
      `went from ${l.sellerNoStock} to ${t.sellerNoStock}. That means orders were accepted on listings that showed ` +
      'stock the seller did not have. Seller-side cancellations also hurt the seller rating and search visibility.',
    dataBasis: 'Reason-level figures are assumed mock data, built to match the given cancellation rates.',
  };
}

// ---------- actions (mock) ----------

function record(state, type, title, detail) {
  const action = { id: `ACT-${state.actions.length + 1}`, type, title, detail, status: 'done' };
  state.actions.push(action);
  return action;
}

function createRestockPlan(state, args = {}) {
  const topN = Math.min(Math.max(int(args.top_n, 4), 1), bestsellersOutOfStock.length);
  const coverDays = Math.min(Math.max(int(args.cover_days, 30), 7), 60);
  const asp = metrics.thisMonth.asp;
  // Quantity = last month's daily run rate x cover days, plus a 20% buffer, rounded up to 5.
  const items = bestsellersOutOfStock.slice(0, topN).map((p, i) => ({
    priority: i + 1,
    sku: p.sku,
    name: p.name,
    restockUnits: Math.ceil(((p.ordersLastMonth / 30) * coverDays * 1.2) / 5) * 5,
    ordersRecoveredPerMonth: p.ordersLastMonth - p.ordersThisMonth,
  }));
  const recovered = items.reduce((a, i) => a + i.ordersRecoveredPerMonth, 0);
  const action = record(
    state,
    'restock_plan',
    `Restock plan created for ${items.length} bestseller${items.length > 1 ? 's' : ''}`,
    items.map((i) => `${i.priority}. ${i.name}: ${i.restockUnits} units`).join('\n'),
  );
  return {
    actionId: action.id,
    status: 'created',
    coverDays,
    items,
    expectedOrdersRecoveredPerMonth: recovered,
    expectedSalesRecoveredRupeesPerMonth: recovered * asp,
  };
}

function enableInventorySafeguard(state, args = {}) {
  const buffer = Math.min(Math.max(int(args.buffer_units, 2), 1), 10);
  const action = record(
    state,
    'inventory_safeguard',
    'Inventory safeguard switched on',
    `Listings pause automatically when stock falls to ${buffer} units, so no order is accepted that cannot be shipped.`,
  );
  return { actionId: action.id, status: 'enabled', bufferUnits: buffer, appliesToListings: seller.activeListings };
}

function setLowStockAlerts(state, args = {}) {
  const days = Math.min(Math.max(int(args.days_of_stock_left, 7), 2), 30);
  const channel = args.channel === 'sms' ? 'SMS' : 'WhatsApp';
  const action = record(
    state,
    'low_stock_alerts',
    'Low-stock alerts set up',
    `${channel} alert when any product has fewer than ${days} days of stock left.`,
  );
  return { actionId: action.id, status: 'enabled', daysOfStockLeft: days, channel };
}

function scheduleFollowup(state, args = {}) {
  const days = Math.min(Math.max(int(args.in_days, 7), 1), 30);
  const date = new Date(Date.now() + days * 86400000);
  const when = date.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  const weekday = date.toLocaleDateString('en-IN', { weekday: 'long' });
  const focus = String(args.focus || 'Check restock progress and cancellation rate');
  const action = record(state, 'followup', `Follow-up call booked for ${when}`, focus);
  return { actionId: action.id, status: 'booked', date: when, sayItAs: days === 7 ? `next ${weekday}` : `${weekday}, in ${days} days`, focus };
}

function escalateToHumanKam(state, args = {}) {
  const reason = String(args.reason || 'Seller asked for a human account manager');
  const action = record(state, 'escalation', 'Raised with the human KAM team', reason);
  return { actionId: action.id, status: 'raised', expectedCallbackWithinHours: 24 };
}

function sendCallSummary(state, args = {}) {
  const list = (v) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
  state.summary = {
    mainIssues: list(args.main_issues),
    recommendations: list(args.recommendations),
    nextSteps: list(args.next_steps),
    actionsTaken: state.actions.map((a) => a.title),
  };
  record(state, 'summary', 'Call summary sent on WhatsApp', 'A written copy of this call was sent to the seller.');
  return { status: 'sent', channel: 'WhatsApp' };
}

// ---------- registry ----------

const registry = {
  get_account_snapshot: { kind: 'analysis', label: 'Checked account snapshot', run: () => getAccountSnapshot() },
  get_stockout_analysis: { kind: 'analysis', label: 'Analysed out-of-stock products', run: () => getStockoutAnalysis() },
  get_cancellation_breakdown: { kind: 'analysis', label: 'Analysed cancellation reasons', run: () => getCancellationBreakdown() },
  create_restock_plan: { kind: 'action', run: createRestockPlan },
  enable_inventory_safeguard: { kind: 'action', run: enableInventorySafeguard },
  set_low_stock_alerts: { kind: 'action', run: setLowStockAlerts },
  schedule_followup: { kind: 'action', run: scheduleFollowup },
  escalate_to_human_kam: { kind: 'action', run: escalateToHumanKam },
  send_call_summary: { kind: 'action', run: sendCallSummary },
};

export function runTool(state, name, args) {
  const tool = registry[name];
  if (!tool) return { kind: 'error', result: { error: `Unknown tool: ${name}` } };
  // Listen-first guard. Nothing is looked up or done until the seller has
  // said why they called.
  if (!state.sellerHasSpoken) {
    return {
      kind: 'held',
      mute: true,
      label: 'Waiting for the seller to speak',
      result: { status: 'held', reason: 'The seller has not spoken yet. Say nothing more. Wait for them to tell you why they called.' },
    };
  }
  // Consent guard. The prompt tells the agent to ask before acting, and this
  // enforces it: if the agent has asked a question and the seller has not
  // spoken since, the action does not run.
  if (tool.kind === 'action' && name !== 'send_call_summary' && /[?？]/.test(state.saidSinceSeller)) {
    return {
      kind: 'held',
      mute: true,
      label: 'Action held until the seller answers',
      result: {
        status: 'held',
        reason:
          'You asked the seller a question and have not heard the answer yet. Nothing was changed. ' +
          'Say nothing more now. Wait for the seller to reply, and call this again only after a clear yes.',
      },
    };
  }
  // Summary guard. The call is not wrapped up in the same breath as the
  // actions: the seller gets at least one turn to ask questions first.
  if (name === 'send_call_summary' && state.actions.length > 0 && state.sellerTurnsSinceAction === 0) {
    return {
      kind: 'held',
      mute: false,
      label: 'Summary held until the seller has had a say',
      result: {
        status: 'held',
        replyLanguage: languageHint[state.sellerLanguage],
        reason:
          'Too early to close. Do not mention a summary or say goodbye. Tell the seller what you just set up and what they need to do, ' +
          'ask if they have any questions, and wait. Send the summary only after they say they have nothing more.',
      },
    };
  }
  try {
    const result = { replyLanguage: languageHint[state.sellerLanguage], ...tool.run(state, args || {}) };
    const action = tool.kind === 'action' ? state.actions[state.actions.length - 1] : null;
    if (tool.kind === 'action' && name !== 'send_call_summary') state.sellerTurnsSinceAction = 0;
    return { kind: tool.kind, label: tool.label, result, action };
  } catch (err) {
    return { kind: 'error', result: { error: String(err.message || err) } };
  }
}

const obj = (properties = {}, required = []) => ({ type: 'OBJECT', properties, required });

export const functionDeclarations = [
  {
    name: 'get_account_snapshot',
    description:
      "Get the seller's headline numbers for last month and this month (sales, orders, cancellation rate, average selling price, out-of-stock products) with the changes already calculated. Call this first, as soon as the seller describes a sales problem.",
  },
  {
    name: 'get_stockout_analysis',
    description:
      'Get which products are out of stock, how many orders each bestseller lost, and what share of the total drop they explain.',
  },
  {
    name: 'get_cancellation_breakdown',
    description: 'Get cancelled orders split by reason (seller had no stock, customer cancelled, delivery failed) for both months.',
  },
  {
    name: 'create_restock_plan',
    description:
      'ACTION. Create a prioritised restock plan with quantities for the out-of-stock bestsellers. Only call after the seller agrees.',
    parameters: obj({
      top_n: { type: 'INTEGER', description: 'How many bestsellers to include, 1 to 4. Use fewer if the seller is short of cash.' },
      cover_days: { type: 'INTEGER', description: 'Days of stock to order for. Default 30.' },
    }),
  },
  {
    name: 'enable_inventory_safeguard',
    description:
      'ACTION. Pause listings automatically when stock falls to a small buffer, so orders are never accepted without stock. This cuts seller-side cancellations. Only call after the seller agrees.',
    parameters: obj({ buffer_units: { type: 'INTEGER', description: 'Units at which a listing pauses. Default 2.' } }),
  },
  {
    name: 'set_low_stock_alerts',
    description: 'ACTION. Alert the seller when a product is close to running out. Only call after the seller agrees.',
    parameters: obj({
      days_of_stock_left: { type: 'INTEGER', description: 'Alert when stock covers fewer than this many days. Default 7.' },
      channel: { type: 'STRING', description: 'whatsapp or sms. Default whatsapp.' },
    }),
  },
  {
    name: 'schedule_followup',
    description: 'ACTION. Book a follow-up call with the seller to review progress.',
    parameters: obj({
      in_days: { type: 'INTEGER', description: 'Days from today. Default 7.' },
      focus: { type: 'STRING', description: 'One line on what the follow-up will check.' },
    }),
  },
  {
    name: 'escalate_to_human_kam',
    description:
      'ACTION. Hand over to a human account manager. Use when the seller asks for a person, or the issue is outside your tools (payments, account suspension, legal, disputes).',
    parameters: obj({ reason: { type: 'STRING', description: 'One line on why.' } }, ['reason']),
  },
  {
    name: 'send_call_summary',
    description:
      'ACTION. Send the written call summary to the seller. Call once, at the end, just before you speak the closing summary. Write every item in English.',
    parameters: obj(
      {
        main_issues: { type: 'ARRAY', items: { type: 'STRING' }, description: 'The key issues found, with numbers.' },
        recommendations: { type: 'ARRAY', items: { type: 'STRING' }, description: 'The 2 or 3 actions recommended.' },
        next_steps: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Who does what by when, for the seller and for you.' },
      },
      ['main_issues', 'recommendations', 'next_steps'],
    ),
  },
];
