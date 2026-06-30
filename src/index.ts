/**
 * Application composition + bootstrap.
 *
 * {@link buildApp} mounts the three routes (Missive webhook, BlueBubbles
 * webhook, health) onto a single Elysia app with no listening side effects, so
 * it is freely usable in tests via `app.handle()`.
 *
 * {@link startServer} wires the real singleton dependencies, listens, and runs
 * the `onStart` boot sequence: ping -> capability.detect -> idempotent
 * BlueBubbles webhook self-register ({@link ensureBbWebhook}) -> start the outbox
 * worker + capability re-probe. Startup is non-fatal: if BlueBubbles is
 * unreachable the bridge still accepts Missive webhooks and queues work, the
 * worker still drains, and `/health` simply reports `ready: false` until a later
 * probe + registration succeed.
 *
 * The real process bootstrap is guarded by `import.meta.main`, so importing this
 * module in a test never binds a port.
 */

import { Elysia } from 'elysia';
import { createWebhook, listWebhooks, ping } from './clients/bluebubbles.ts';
import { config } from './config.ts';
import { type Db, db } from './db.ts';
import { detect, getCaps, startReprobe } from './domain/capability.ts';
import { logger } from './logger.ts';
import { startWorker, type Worker } from './queue/outbox.ts';
import { createLimiter } from './queue/ratelimiter.ts';
import { bbWebhookRoute } from './routes/bb-webhook.ts';
import { healthRoute } from './routes/health.ts';
import { missiveWebhookRoute } from './routes/missive-webhook.ts';
import type { Config } from './types.ts';

/** A running application handle. */
export interface AppHandle {
  /** The composed Elysia app (useful for `app.handle()` in tests). */
  app: Elysia;
  /** Stop the server + worker and close resources. */
  stop(): Promise<void>;
}

/** BlueBubbles webhook events the bridge subscribes to on self-registration. */
const WEBHOOK_EVENTS = [
  'new-message',
  'updated-message',
  'message-send-error',
  'group-name-change',
  'group-icon-changed',
  'group-icon-removed',
  'participant-added',
  'participant-removed',
  'participant-left',
  'chat-read-status-changed',
  'typing-indicator',
] as const;

/**
 * Boot readiness flag shared with the health route. Flips true only once ping +
 * server/info + webhook self-registration have all succeeded; reset on stop.
 */
let ready = false;

/** Daily prune sweep interval (ms). */
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Retention horizon (ms): dedup ledger / message cache / done outbox older than this are pruned. */
export const PRUNE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Schedule the daily prune sweep that bounds the dedup ledger, message cache,
 * and done-outbox tables. The timer is unref'd so it never keeps the process
 * alive on its own; returns a stop function.
 *
 * @param database - The database to prune.
 * @param intervalMs - Sweep interval (defaults to {@link PRUNE_INTERVAL_MS}).
 * @param retentionMs - Retention horizon (defaults to {@link PRUNE_RETENTION_MS}).
 */
export function startPruneSweep(
  database: Db,
  intervalMs: number = PRUNE_INTERVAL_MS,
  retentionMs: number = PRUNE_RETENTION_MS,
): () => void {
  const timer = setInterval(() => {
    database.pruneOld(database.now() - retentionMs);
    logger.debug('prune sweep complete');
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
  };
}

/** Compose the Elysia app by mounting all routes (no listening side effects). */
export function buildApp(appConfig: Config): Elysia {
  // Pin the declared contract type (exactOptionalPropertyTypes friction).
  return new Elysia()
    .use(missiveWebhookRoute({ db, logger, hmacSecret: appConfig.MISSIVE_HMAC_SECRET }))
    .use(
      bbWebhookRoute({
        db,
        logger,
        hookToken: appConfig.BB_HOOK_TOKEN,
        receiptsAsPosts: appConfig.RECEIPTS_AS_POSTS,
      }),
    )
    .use(healthRoute({ db, getCaps, isReady: () => ready })) as unknown as Elysia;
}

/**
 * Idempotently register the BlueBubbles webhook: list existing targets, and
 * create ours only if the exact URL is absent (so a reboot never duplicates).
 */
export async function ensureBbWebhook(appConfig: Config): Promise<void> {
  const url = `${appConfig.PUBLIC_URL}/bb/webhook/${appConfig.BB_HOOK_TOKEN}`;
  const existing = await listWebhooks();
  if (existing.some((hook) => hook.url === url)) {
    logger.info('bb webhook already registered');
    return;
  }
  await createWebhook({ url, events: [...WEBHOOK_EVENTS] });
  logger.info('bb webhook registered');
}

/** Wire dependencies, run the boot sequence, and listen. */
export async function startServer(appConfig: Config): Promise<AppHandle> {
  const app = buildApp(appConfig);
  const limiter = createLimiter();
  let worker: Worker | null = null;
  let stopReprobe: (() => void) | null = null;
  let stopPrune: (() => void) | null = null;

  let resolveBoot!: () => void;
  const bootDone = new Promise<void>((resolve) => {
    resolveBoot = resolve;
  });

  app.onStart(async () => {
    try {
      if (await ping()) {
        await detect();
        await ensureBbWebhook(appConfig);
        ready = true;
        logger.info('bridge ready');
      } else {
        logger.warn('bluebubbles unreachable at boot; accepting webhooks and queueing only');
      }
    } catch (err) {
      logger.error('boot sequence failed; will re-probe in background', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Recover any leases orphaned by a crash mid-dispatch before draining.
      db.requeueClaimed();
      // Always start the worker + re-probe + prune sweep so queued work drains
      // and caps recover even if the initial boot probe failed (startup is non-fatal).
      stopReprobe = startReprobe(appConfig.CAPS_REPROBE_MS);
      stopPrune = startPruneSweep(db);
      worker = startWorker({ db, limiter, logger, receiptsAsPosts: appConfig.RECEIPTS_AS_POSTS });
      resolveBoot();
    }
  });

  app.listen(appConfig.PORT);
  await bootDone;

  return {
    app,
    stop: async () => {
      ready = false;
      stopReprobe?.();
      stopPrune?.();
      if (worker) await worker.stop();
      await app.stop();
    },
  };
}

if (import.meta.main) void startServer(config);
