// Call history.
//
// Each finished call is saved with its summary and the actions the agent took,
// so the seller can see past calls on the page and the agent can pick up where
// the last call ended.
//
// With DATABASE_URL set, calls are kept in Postgres and survive restarts.
// Without it they go to a local file (logs/calls.json), which is enough for
// running on a laptop but is lost when a hosted server restarts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'logs', 'calls.json');
const DATABASE_URL = process.env.DATABASE_URL || '';

let pool = null;
let ready = null;

async function db() {
  if (!DATABASE_URL) return null;
  if (!pool) {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
    ready = pool.query(`
      CREATE TABLE IF NOT EXISTS calls (
        id SERIAL PRIMARY KEY,
        seller_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        overview TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL DEFAULT '',
        issues JSONB NOT NULL DEFAULT '[]',
        recommendations JSONB NOT NULL DEFAULT '[]',
        next_steps JSONB NOT NULL DEFAULT '[]',
        actions JSONB NOT NULL DEFAULT '[]'
      )`);
  }
  await ready;
  return pool;
}

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

export const storeKind = DATABASE_URL ? 'postgres' : 'file';

// call: { overview, outcome, issues[], recommendations[], nextSteps[], actions[] }
export async function saveCall(sellerId, call) {
  const pg = await db();
  if (pg) {
    await pg.query(
      'INSERT INTO calls (seller_id, overview, outcome, issues, recommendations, next_steps, actions) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [sellerId, call.overview, call.outcome, JSON.stringify(call.issues), JSON.stringify(call.recommendations), JSON.stringify(call.nextSteps), JSON.stringify(call.actions)],
    );
    return;
  }
  const all = readFile();
  all.push({ sellerId, at: new Date().toISOString(), ...call });
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all.slice(-200), null, 2));
}

// Most recent first.
export async function listCalls(sellerId, limit = 5) {
  const pg = await db();
  if (pg) {
    const { rows } = await pg.query(
      'SELECT created_at, overview, outcome, issues, recommendations, next_steps, actions FROM calls WHERE seller_id = $1 ORDER BY created_at DESC LIMIT $2',
      [sellerId, limit],
    );
    return rows.map((r) => ({
      at: r.created_at.toISOString(),
      overview: r.overview,
      outcome: r.outcome,
      issues: r.issues,
      recommendations: r.recommendations,
      nextSteps: r.next_steps,
      actions: r.actions,
    }));
  }
  return readFile()
    .filter((c) => c.sellerId === sellerId)
    .slice(-limit)
    .reverse()
    .map(({ sellerId: _ignored, ...call }) => call);
}
