/**
 * Tests for the monitoring dashboard route (spec-first).
 *
 * Covers the constant-time token guard across all three routes (same-length
 * mismatch, different-length mismatch, and the `token: null` disabled path,
 * each with the required `logger.warn`), the HTML page (headers, doctype, title
 * marker, and that the token is never reflected into the body), the `/stats`
 * JSON snapshot (dep passthroughs, per-status outbox counts, the 20-cap +
 * newest-first + key-projected dead-job list, and the 24h activity window with
 * its inclusive cutoff + `is_from_me` / `echo_consumed` filters), and the
 * `/retry/:id` matrix (dead -> revived, pending -> 409, unknown/non-numeric/
 * non-positive -> 404, bad token -> 404 with the dead row untouched).
 *
 * State is seeded ONLY via the public Db API; the clock is fixed so `db.now()`
 * and every `created_at` are deterministic.
 */

import { describe, expect, it } from 'bun:test';
import { createDb, type Db } from '../../src/db.ts';
import type { Logger } from '../../src/logger.ts';
import {
  type DashboardStats,
  DEAD_JOBS_LIMIT,
  dashboardRoute,
} from '../../src/routes/dashboard.ts';
import type { Caps } from '../../src/types.ts';

/** Fixed harness clock (epoch ms, well past the 24h window). */
const CLOCK = 1_700_000_000_000;
/** The 24h activity window in ms. */
const DAY = 86_400_000;
/** A >= 32-char dashboard token. */
const TOKEN = 'dashboard-token-0123456789abcdef-0123';
/** Default caps passthrough. */
const CAPS: Caps = { privateApi: true, helperConnected: true, lastProbeAt: 4_242 };

/** A logger that records every emitted line for assertions. */
function makeLogger(): Logger & { calls: { level: string; msg: string }[] } {
  const calls: { level: string; msg: string }[] = [];
  const at =
    (level: string) =>
    (msg: string): void => {
      calls.push({ level, msg });
    };
  return { calls, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

interface Harness {
  db: Db;
  logger: ReturnType<typeof makeLogger>;
  page: (tok: string) => Promise<Response>;
  stats: (tok: string) => Promise<Response>;
  retry: (tok: string, id: number | string) => Promise<Response>;
}

/** Build a fresh in-memory DB (fixed clock) + the dashboard route under test. */
function harness(
  opts: { token?: string | null; caps?: Caps; ready?: boolean; missiveInFlight?: number } = {},
): Harness {
  const db = createDb(':memory:', () => CLOCK);
  const logger = makeLogger();
  const app = dashboardRoute({
    db,
    logger,
    getCaps: () => opts.caps ?? CAPS,
    isReady: () => opts.ready ?? true,
    token: opts.token === undefined ? TOKEN : opts.token,
    missiveInFlight: () => opts.missiveInFlight ?? 0,
  });
  return {
    db,
    logger,
    page: (tok) => app.handle(new Request(`http://localhost/dashboard/${tok}`)),
    stats: (tok) => app.handle(new Request(`http://localhost/dashboard/${tok}/stats`)),
    retry: (tok, id) =>
      app.handle(new Request(`http://localhost/dashboard/${tok}/retry/${id}`, { method: 'POST' })),
  };
}

/** Run `fn` with the DB clock pinned to `t`, then restore the fixed CLOCK. */
function withClock(db: Db, t: number, fn: () => void): void {
  db.setClock(() => t);
  try {
    fn();
  } finally {
    db.setClock(() => CLOCK);
  }
}

/** Enqueue `n` jobs (each on a unique chat) and return their ids, ascending. */
function enqueueUnique(db: Db, prefix: string, n: number): void {
  for (let i = 0; i < n; i += 1) {
    db.enqueue({ kind: 'missive_post', chat_guid: `${prefix}-${i}`, payload: { i } });
  }
}

// ---------------------------------------------------------------------------
// Token guard — every route, every bad-token variant.
// ---------------------------------------------------------------------------

const ROUTES: { name: string; call: (h: Harness, tok: string) => Promise<Response> }[] = [
  { name: 'GET /dashboard/:token', call: (h, tok) => h.page(tok) },
  { name: 'GET /dashboard/:token/stats', call: (h, tok) => h.stats(tok) },
  { name: 'POST /dashboard/:token/retry/:id', call: (h, tok) => h.retry(tok, 1) },
];

describe('dashboardRoute — token guard', () => {
  for (const route of ROUTES) {
    it(`${route.name} rejects a same-length wrong token with 404 + warn`, async () => {
      const h = harness();
      const wrong = `${TOKEN.slice(0, -1)}X`;
      expect(wrong.length).toBe(TOKEN.length);
      const res = await route.call(h, wrong);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('not found');
      expect(h.logger.calls.some((c) => c.level === 'warn')).toBe(true);
    });

    it(`${route.name} rejects a different-length token with 404 + warn`, async () => {
      const h = harness();
      const res = await route.call(h, 'short');
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('not found');
      expect(h.logger.calls.some((c) => c.level === 'warn')).toBe(true);
    });

    it(`${route.name} 404s + warns when the dashboard is disabled (token: null)`, async () => {
      const h = harness({ token: null });
      const res = await route.call(h, TOKEN);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('not found');
      expect(h.logger.calls.some((c) => c.level === 'warn')).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// GET /dashboard/:token — the HTML page.
// ---------------------------------------------------------------------------

describe('dashboardRoute — GET /dashboard/:token (page)', () => {
  it('serves the HTML shell with no-store and never reflects the token', async () => {
    const h = harness();
    const res = await h.page(TOKEN);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = await res.text();
    expect(body.startsWith('<!doctype html>')).toBe(true);
    expect(body).toContain('<title>Bridge dashboard</title>');
    // The token must never be embedded in the page.
    expect(body).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// GET /dashboard/:token/stats — the JSON snapshot.
// ---------------------------------------------------------------------------

describe('dashboardRoute — GET /dashboard/:token/stats', () => {
  it('returns no-store JSON that passes through caps/ready/missiveInFlight/now on an empty db', async () => {
    const caps: Caps = { privateApi: false, helperConnected: false, lastProbeAt: 111 };
    const h = harness({ caps, ready: false, missiveInFlight: 7 });
    const res = await h.stats(TOKEN);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = (await res.json()) as DashboardStats;
    // Passthroughs (values chosen to differ from any plausible hardcoded default).
    expect(body.caps).toEqual(caps);
    expect(body.ready).toBe(false);
    expect(body.missiveInFlight).toBe(7);
    expect(body.now).toBe(CLOCK);
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    // Empty-db shape.
    expect(body.outbox).toEqual({ pending: 0, claimed: 0, done: 0, dead: 0 });
    expect(body.deadJobs).toEqual([]);
    expect(body.activity24h).toEqual({ inbound: 0, outbound: 0, echoesSuppressed: 0 });
  });

  it('reports outbox row counts for every status', async () => {
    const h = harness();
    const { db } = h;

    // dead x3 (enqueue -> claim -> markDead).
    enqueueUnique(db, 'dead', 3);
    for (const r of db.claimDueJobs(db.now(), 100)) db.markDead(r.id, 'boom');
    // done x1.
    enqueueUnique(db, 'done', 1);
    for (const r of db.claimDueJobs(db.now(), 100)) db.markDone(r.id);
    // claimed x1 (claim, leave in the claimed state).
    enqueueUnique(db, 'claimed', 1);
    db.claimDueJobs(db.now(), 100);
    // pending x2 (enqueued last so nothing claims them).
    enqueueUnique(db, 'pending', 2);

    const body = (await (await h.stats(TOKEN)).json()) as DashboardStats;
    expect(body.outbox).toEqual({ pending: 2, claimed: 1, done: 1, dead: 3 });
  });

  it('caps dead jobs at 20, newest-first, projected to exactly the summary keys', async () => {
    const h = harness();
    const { db } = h;

    // 21 dead jobs to prove the cap drops the single oldest row.
    enqueueUnique(db, 'dead', 21);
    const ids: number[] = [];
    for (const r of db.claimDueJobs(db.now(), 100)) {
      db.markDead(r.id, `err-${r.id}`);
      ids.push(r.id); // claimDueJobs orders by id ascending
    }
    expect(ids).toHaveLength(21);

    const body = (await (await h.stats(TOKEN)).json()) as DashboardStats;

    // Capped at the exported limit (20), not the 21 total dead rows.
    expect(DEAD_JOBS_LIMIT).toBe(20);
    expect(body.outbox.dead).toBe(21);
    expect(body.deadJobs).toHaveLength(DEAD_JOBS_LIMIT);

    // Newest-first == descending id; the single oldest id is dropped.
    const gotIds = body.deadJobs.map((j) => j.id);
    const expectedNewest = [...ids].sort((a, b) => b - a).slice(0, DEAD_JOBS_LIMIT);
    expect(gotIds).toEqual(expectedNewest);
    expect(gotIds).not.toContain(Math.min(...ids));
    for (let i = 1; i < gotIds.length; i += 1) {
      expect(gotIds[i - 1]).toBeGreaterThan(gotIds[i] as number);
    }

    // Projection: exactly the DeadJobSummary keys, no `payload` leaked.
    const first = body.deadJobs[0];
    if (first === undefined) throw new Error('expected a dead job');
    expect(Object.keys(first).sort()).toEqual(
      ['attempts', 'chat_guid', 'created_at', 'id', 'kind', 'last_error'].sort(),
    );
    expect(first).not.toHaveProperty('payload');
    // Values on the newest row (the 21st enqueued, chat `dead-20`).
    expect(first.kind).toBe('missive_post');
    expect(first.chat_guid).toBe('dead-20');
    expect(first.attempts).toBe(0);
    expect(first.last_error).toBe(`err-${first.id}`);
    expect(first.created_at).toBe(CLOCK);
  });

  it('counts inbound activity only for is_from_me=0 messages inside the 24h window', async () => {
    const h = harness();
    const { db } = h;
    const cutoff = CLOCK - DAY;

    db.cacheMessage('m-recent', 'c-a', 'x', false); // now -> counts
    withClock(db, cutoff, () => db.cacheMessage('m-edge', 'c-b', 'y', false)); // AT cutoff -> counts
    withClock(db, cutoff - 1, () => db.cacheMessage('m-old', 'c-c', 'z', false)); // before -> excluded
    db.cacheMessage('m-mine', 'c-d', 'w', true); // is_from_me=1 -> excluded

    const body = (await (await h.stats(TOKEN)).json()) as DashboardStats;
    expect(body.activity24h.inbound).toBe(2);
  });

  it('counts all in-window sends as outbound and only consumed ones as echoesSuppressed', async () => {
    const h = harness();
    const { db } = h;
    const cutoff = CLOCK - DAY;

    // now: a plain send + a send whose echo we consume.
    db.recordSend({ tempGuid: 'tg1', chatGuid: 'c1', missiveMsgId: 'mm1', text: 'a' });
    db.recordSend({ tempGuid: 'tg2', chatGuid: 'c2', missiveMsgId: 'mm2', text: 'b' });
    expect(db.consumeEcho({ chatGuid: 'c2', text: 'b', sinceMs: 0 })).not.toBeNull();
    // AT the cutoff -> still in-window.
    withClock(db, cutoff, () =>
      db.recordSend({ tempGuid: 'tg3', chatGuid: 'c3', missiveMsgId: 'mm3', text: 'c' }),
    );
    // Just before the cutoff -> excluded.
    withClock(db, cutoff - 1, () =>
      db.recordSend({ tempGuid: 'tg4', chatGuid: 'c4', missiveMsgId: 'mm4', text: 'd' }),
    );

    const body = (await (await h.stats(TOKEN)).json()) as DashboardStats;
    expect(body.activity24h.outbound).toBe(3); // tg1, tg2, tg3
    expect(body.activity24h.echoesSuppressed).toBe(1); // tg2 only
  });
});

// ---------------------------------------------------------------------------
// POST /dashboard/:token/retry/:id — the retry matrix.
// ---------------------------------------------------------------------------

/** Seed a single dead job and return its id. */
function seedDeadJob(db: Db, chat = 'c-dead'): number {
  db.enqueue({ kind: 'missive_post', chat_guid: chat, payload: { x: 1 } });
  const [claimed] = db.claimDueJobs(db.now(), 1);
  if (claimed === undefined) throw new Error('expected a claimable job');
  db.markDead(claimed.id, 'boom');
  return claimed.id;
}

describe('dashboardRoute — POST /dashboard/:token/retry/:id', () => {
  it('revives a dead job: 200 {ok,id} and resets the row to pending', async () => {
    const h = harness();
    const { db } = h;
    const id = seedDeadJob(db);

    const res = await h.retry(TOKEN, id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id });

    const row = db.raw
      .query('SELECT status, attempts, next_at, last_error FROM outbox WHERE id = $id')
      .get({ id });
    expect(row).toEqual({ status: 'pending', attempts: 0, next_at: CLOCK, last_error: null });
  });

  it('returns 409 "not dead" for a pending job and leaves it pending', async () => {
    const h = harness();
    const { db } = h;
    db.enqueue({ kind: 'missive_post', chat_guid: 'c-pending', payload: {} });
    const { id } = db.raw.query('SELECT id FROM outbox ORDER BY id DESC LIMIT 1').get() as {
      id: number;
    };

    const res = await h.retry(TOKEN, id);
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('not dead');

    const row = db.raw.query('SELECT status FROM outbox WHERE id = $id').get({ id });
    expect(row).toEqual({ status: 'pending' });
  });

  it('returns 404 "not found" for an unknown id', async () => {
    const h = harness();
    const res = await h.retry(TOKEN, 999_999);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('not found');
  });

  it('returns 404 "not found" for a non-numeric id', async () => {
    const h = harness();
    const res = await h.retry(TOKEN, 'abc');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('not found');
  });

  it('returns 404 "not found" for a non-positive id (/retry/0)', async () => {
    const h = harness();
    const res = await h.retry(TOKEN, 0);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('not found');
  });

  it('rejects a bad token with 404 and leaves the dead row untouched', async () => {
    const h = harness();
    const { db } = h;
    const id = seedDeadJob(db);

    const res = await h.retry(`${TOKEN.slice(0, -1)}X`, id);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('not found');

    const row = db.raw.query('SELECT status FROM outbox WHERE id = $id').get({ id });
    expect(row).toEqual({ status: 'dead' });
  });
});
