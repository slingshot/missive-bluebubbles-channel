/**
 * Tests for the health route.
 *
 * Verifies both `GET /health` and `GET /` report the injected caps + readiness,
 * the live pending-outbox depth (filtered by status), and a non-negative uptime.
 */

import { describe, expect, it } from 'bun:test';
import { createDb, type Db } from '../../src/db.ts';
import { type HealthReport, healthRoute } from '../../src/routes/health.ts';
import type { Caps } from '../../src/types.ts';

const CAPS: Caps = { privateApi: true, helperConnected: true, lastProbeAt: 1_234_567 };

/** Build a route with an injectable readiness flag + seeded outbox depth. */
function harness(opts: { ready?: boolean; pending?: number } = {}): {
  db: Db;
  setReady: (r: boolean) => void;
  health: () => Promise<Response>;
  root: () => Promise<Response>;
} {
  const db = createDb(':memory:', () => 2_000_000);
  for (let i = 0; i < (opts.pending ?? 0); i += 1) {
    db.enqueue({ kind: 'missive_post', chat_guid: `c${i}`, payload: { i } });
  }
  let ready = opts.ready ?? false;
  const app = healthRoute({ db, getCaps: () => CAPS, isReady: () => ready });
  return {
    db,
    setReady: (r) => {
      ready = r;
    },
    health: () => app.handle(new Request('http://localhost/health')),
    root: () => app.handle(new Request('http://localhost/')),
  };
}

describe('healthRoute', () => {
  it('reports caps, depth, and not-ready on GET /health', async () => {
    const { health } = harness({ ready: false, pending: 2 });
    const res = await health();
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthReport;
    expect(body.ready).toBe(false);
    expect(body.caps).toEqual(CAPS);
    expect(body.outboxDepth).toBe(2);
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it('serves the same report on GET /', async () => {
    const { root } = harness({ ready: true, pending: 1 });
    const res = await root();
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthReport;
    expect(body.ready).toBe(true);
    expect(body.outboxDepth).toBe(1);
  });

  it('reflects readiness flips and excludes non-pending rows from depth', async () => {
    const { db, setReady, health } = harness({ ready: false, pending: 2 });

    // Marking one job done drops it out of the pending depth.
    const [first] = db.claimDueJobs(db.now(), 1);
    db.markDone((first as { id: number }).id);

    setReady(true);
    const body = (await (await health()).json()) as HealthReport;
    expect(body.ready).toBe(true);
    expect(body.outboxDepth).toBe(1);
  });
});
