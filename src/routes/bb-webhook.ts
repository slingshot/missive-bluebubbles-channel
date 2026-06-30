/**
 * BlueBubbles webhook route.
 *
 * `POST /bb/webhook/:token` — the BlueBubbles webhook is UNSIGNED, so the path
 * token is compared in constant time and a mismatch returns `404` (and the body
 * size is capped). Events are dedup-keyed per class ({@link bbDedupKey}); a
 * non-ephemeral event runs through a single-tx dedup+enqueue('missive_post')
 * carrying its resolved `chat_guid` (load-bearing for the per-chat barrier)
 * before acking `200`. Ephemeral events (typing-indicator / read-status, whose
 * dedup key is `null`) are dropped with an in-memory per-chat throttle and never
 * persisted.
 */

import { timingSafeEqual } from 'node:crypto';
import { Elysia } from 'elysia';
import type { Db } from '../db.ts';
import type { Logger } from '../logger.ts';
import type { BbWebhook } from '../types.ts';
import { bbDedupKey } from '../util.ts';

/** Injected dependencies for the BlueBubbles webhook route. */
export interface BbWebhookDeps {
  /** Database (atomic dedup + enqueue). */
  db: Db;
  /** Leveled logger. */
  logger: Logger;
  /** The expected path token guarding this unsigned endpoint. */
  hookToken: string;
  /** When true, surface read receipts as Posts comments (enqueue read-status). */
  receiptsAsPosts?: boolean;
}

/** Hard cap on the BlueBubbles webhook JSON body (metadata only — no bytes). */
const MAX_BODY_BYTES = 2_000_000;

/** Minimum spacing between logged ephemeral events for one chat (ms). */
const EPHEMERAL_THROTTLE_MS = 10_000;

/** Constant-time string comparison (length-checked so it never throws). */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Drop ephemeral-throttle entries older than the throttle window so the
 * in-memory map can't grow unbounded across a long-lived bridge's many chats
 * (a stale entry would just log/enqueue again on its next event anyway).
 *
 * @param map - The per-throttle-key last-seen timestamp map.
 * @param nowMs - Current epoch ms.
 */
export function evictStaleEphemeral(map: Map<string, number>, nowMs: number): void {
  for (const [key, ts] of map) {
    if (nowMs - ts >= EPHEMERAL_THROTTLE_MS) map.delete(key);
  }
}

/**
 * Best-effort resolution of the chat guid an event belongs to, used as the
 * outbox row's `chat_guid` so the per-chat barrier serializes it correctly:
 *  - `new-message` (+ group events with `chats[]`) -> `data.chats[0].guid`,
 *  - events carrying an explicit `data.chatGuid` -> that value,
 *  - `updated-message` / tapbacks (no `chats[]`) -> looked up from the cache.
 */
function eventChatGuid(evt: BbWebhook, db: Db): string | null {
  const data = (evt.data ?? {}) as Record<string, unknown>;
  const chats = data.chats as ReadonlyArray<{ guid?: string }> | undefined;
  const firstChat = chats?.[0]?.guid;
  if (firstChat) return firstChat;
  if (typeof data.chatGuid === 'string') return data.chatGuid;
  if (typeof data.guid === 'string') {
    const resolved = db.lookupChatForMessage(data.guid);
    if (resolved) return resolved;
  }
  return null;
}

/** Build the Elysia plugin exposing `POST /bb/webhook/:token`. */
export function bbWebhookRoute(deps: BbWebhookDeps): Elysia {
  const { db, logger, hookToken } = deps;
  const receiptsAsPosts = deps.receiptsAsPosts ?? false;
  /** Per-chat last-logged time for ephemeral events (in-memory throttle). */
  const lastEphemeralAt = new Map<string, number>();

  return new Elysia().post(
    '/bb/webhook/:token',
    async ({ params, request, status }) => {
      // Constant-time token guard first; reveal nothing on mismatch.
      if (!constantTimeEqual(params.token, hookToken)) {
        logger.warn('bb webhook rejected: bad token');
        return status(404, 'not found');
      }

      const raw = Buffer.from(await request.arrayBuffer());
      if (raw.length > MAX_BODY_BYTES) {
        logger.warn('bb webhook rejected: body too large', { bytes: raw.length });
        return status(413, 'payload too large');
      }

      let evt: BbWebhook;
      try {
        evt = JSON.parse(raw.toString('utf8')) as BbWebhook;
      } catch {
        logger.warn('bb webhook rejected: invalid json');
        return status(400, 'invalid json');
      }

      const chatGuid = eventChatGuid(evt, db);
      const dedupKey = bbDedupKey(evt.type, evt.data);
      if (dedupKey === null) {
        // Ephemeral: typing-indicator / chat-read-status-changed. Throttled
        // in-memory (never persistently deduped). A read-status is enqueued as a
        // Posts comment when RECEIPTS_AS_POSTS; everything else is dropped.
        const throttleKey = `${evt.type}:${chatGuid ?? ''}`;
        const nowMs = db.now();
        const last = lastEphemeralAt.get(throttleKey) ?? 0;
        if (nowMs - last >= EPHEMERAL_THROTTLE_MS) {
          lastEphemeralAt.set(throttleKey, nowMs);
          evictStaleEphemeral(lastEphemeralAt, nowMs);
          if (receiptsAsPosts && evt.type === 'chat-read-status-changed') {
            db.enqueue({ kind: 'missive_post', chat_guid: chatGuid, payload: evt });
            logger.debug('bb read receipt enqueued as post', { type: evt.type });
          } else {
            logger.debug('bb ephemeral event dropped', { type: evt.type });
          }
        }
        return status(200, 'ok');
      }

      // Atomic mark-seen + enqueue (invariant #1). Duplicates still ack 200.
      const fresh = db.dedupAndEnqueue(dedupKey, {
        kind: 'missive_post',
        chat_guid: chatGuid,
        payload: evt,
      });
      logger.info('bb webhook accepted', { type: evt.type, fresh });
      return status(200, 'ok');
    },
    { parse: 'none' },
    // Pin the declared contract type (exactOptionalPropertyTypes friction).
  ) as unknown as Elysia;
}
