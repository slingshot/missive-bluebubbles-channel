/**
 * Missive outbound webhook route.
 *
 * `POST /missive/webhook` with `{ parse: 'none' }`: the raw request bytes are
 * read once, the `X-Hook-Signature` HMAC is verified against those bytes
 * (constant-time, length-checked) and a mismatch returns `401` **before** the
 * body is ever parsed (invariant #1 HMAC — never re-serialize parsed JSON for
 * the digest). On success the parsed webhook is run through a single-tx
 * dedup+enqueue('bb_send') and the route acks `200` immediately; all BlueBubbles
 * work happens later in the worker (Missive retries on a >15s ack).
 */

import { Elysia } from 'elysia';
import type { Db } from '../db.ts';
import { dmChatGuid, parseChatReference } from '../domain/outbound.ts';
import type { Logger } from '../logger.ts';
import type { MissiveOutboundWebhook } from '../types.ts';
import { verifyHmac } from '../util.ts';

/** Injected dependencies for the Missive webhook route. */
export interface MissiveWebhookDeps {
  /** Database (atomic dedup + enqueue). */
  db: Db;
  /** Leveled logger. */
  logger: Logger;
  /** Shared HMAC secret used to verify `X-Hook-Signature`. */
  hmacSecret: string;
}

/**
 * Best-effort barrier key for an outbound send so concurrent sends that target
 * the same chat (or the same brand-new number) serialize under the per-chat
 * barrier and don't fork (invariant #4). It is ONLY the barrier key — the worker
 * resolves the real send target itself. Resolution mirrors the planner: bound
 * conversation, then a `bb-chat-<guid>` reference, then the deterministic DM guid
 * for a single recipient (so two first-contact sends to one number serialize and
 * the second resolves the chat the first created instead of creating a fork).
 */
export function outboundBarrierChatGuid(hook: MissiveOutboundWebhook, db: Db): string | null {
  const convId = hook.conversation?.id;
  if (convId) {
    const byConv = db.getChatByConversation(convId);
    if (byConv) return byConv.chat_guid;
  }
  const ref = parseChatReference(hook.message.references);
  if (ref && db.getChatByGuid(ref)) return ref;
  const fields = hook.message.to_fields ?? [];
  if (fields.length === 1) {
    const f = fields[0];
    if (f) {
      const address = f.username && f.username.trim() !== '' ? f.username : f.id;
      if (address) return dmChatGuid(address);
    }
  }
  return null;
}

/** Build the Elysia plugin exposing `POST /missive/webhook`. */
export function missiveWebhookRoute(deps: MissiveWebhookDeps): Elysia {
  const { db, logger, hmacSecret } = deps;

  return new Elysia().post(
    '/missive/webhook',
    async ({ request, status }) => {
      // Read the RAW bytes once and verify the HMAC over them, before any parse.
      const raw = Buffer.from(await request.arrayBuffer());
      const signature = request.headers.get('X-Hook-Signature');
      if (!verifyHmac(hmacSecret, raw, signature)) {
        logger.warn('missive webhook rejected: bad signature');
        return status(401, 'invalid signature');
      }

      let hook: MissiveOutboundWebhook;
      try {
        hook = JSON.parse(raw.toString('utf8')) as MissiveOutboundWebhook;
      } catch {
        logger.warn('missive webhook rejected: invalid json');
        return status(400, 'invalid json');
      }

      const messageId = hook.message?.id;
      if (!messageId) {
        logger.warn('missive webhook rejected: missing message id');
        return status(400, 'missing message id');
      }

      // Atomic mark-seen + enqueue (invariant #1). Duplicates still ack 200. The
      // barrier key serializes concurrent sends to the same chat / new number (#4).
      const fresh = db.dedupAndEnqueue(`missive:${messageId}`, {
        kind: 'bb_send',
        chat_guid: outboundBarrierChatGuid(hook, db),
        payload: hook,
      });
      logger.info('missive webhook accepted', { messageId, fresh });
      return status(200, 'ok');
    },
    { parse: 'none' },
    // The inferred route-specialized instance is structurally an `Elysia`; the
    // cast pins the declared contract type (exactOptionalPropertyTypes friction).
  ) as unknown as Elysia;
}
