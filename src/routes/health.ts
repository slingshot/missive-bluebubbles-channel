/**
 * Health route.
 *
 * `GET /health` and `GET /` report the capability snapshot (incl. its
 * `lastProbeAt`), the current pending-outbox depth, process uptime, and a
 * `ready` flag that flips true once boot ping + server/info + webhook
 * self-registration have all succeeded. The endpoint never performs network I/O
 * (it only reads the cached caps + a cheap COUNT), so it is safe to poll.
 */

import { Elysia } from 'elysia';
import type { Db } from '../db.ts';
import type { Caps } from '../types.ts';

/** The JSON body returned by the health endpoints. */
export interface HealthReport {
  readonly ready: boolean;
  readonly caps: Caps;
  readonly outboxDepth: number;
  readonly uptimeMs: number;
}

/** Injected dependencies for the health route. */
export interface HealthDeps {
  /** Database (outbox depth). */
  db: Db;
  /** Current capability snapshot. */
  getCaps(): Caps;
  /** Whether boot self-registration has completed. */
  isReady(): boolean;
}

/** Count pending (undispatched) outbox rows — the live work backlog. */
function outboxDepth(db: Db): number {
  const row = db.raw
    .query("SELECT COUNT(*) AS depth FROM outbox WHERE status = 'pending'")
    .get() as { depth: number };
  return Number(row.depth);
}

/** Build the Elysia plugin exposing `GET /health` and `GET /`. */
export function healthRoute(deps: HealthDeps): Elysia {
  const { db, getCaps, isReady } = deps;
  const startedAt = Date.now();

  const report = (): HealthReport => ({
    ready: isReady(),
    caps: getCaps(),
    outboxDepth: outboxDepth(db),
    uptimeMs: Date.now() - startedAt,
  });

  // Pin the declared contract type (exactOptionalPropertyTypes friction).
  return new Elysia().get('/health', () => report()).get('/', () => report()) as unknown as Elysia;
}
