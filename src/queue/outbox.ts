/**
 * Durable outbox worker — the ONLY place the bridge performs side effects.
 *
 * The webhook routes do nothing but verify + atomically dedup/enqueue; this
 * worker drains the `outbox` table and wires together the database, the pure
 * domain planners, and the BlueBubbles / Missive HTTP clients:
 *
 *  - **`bb_send`** (Missive -> BlueBubbles, an agent sent a message):
 *    {@link planOutbound} resolves the target chat and a single send op, the
 *    `tempGuid` is recorded *before* the send (and reused verbatim on retry so
 *    BlueBubbles' sendCache dedups a crash-after-deliver — invariant #8), then
 *    exactly one of `message/text` / `message/attachment` / `chat/new` runs
 *    (invariant #3). The returned message guid is stored for echo correlation,
 *    and a learned Missive conversation id is bound onto the chat (invariant #6).
 *
 *  - **`missive_post`** (BlueBubbles -> Missive, an incoming iMessage):
 *    self-echoes are consumed-on-match and dropped (invariant #5) before
 *    {@link planInbound} builds the Missive post(s); the worker downloads each
 *    attachment's bytes, inlines them as base64, and posts under the Missive
 *    rate limiter.
 *
 * Failures are classified (permanent 4xx -> dead-letter; transient 5xx/network
 * -> retry) and rescheduled with exponential backoff + full jitter, honoring a
 * `Retry-After` exactly when Missive returns one, dead-lettering after
 * {@link MAX_ATTEMPTS}. The per-chat head-of-line barrier lives in
 * {@link Db.claimDueJobs}; different chats drain concurrently.
 */

import type { BbClientOptions, BbMethod } from '../clients/bluebubbles.ts';
import {
  BbError,
  chatNew,
  downloadAttachment,
  handleAvailabilityImessage,
  sendAttachment,
  sendMultipart,
  sendText,
  uploadAttachment,
} from '../clients/bluebubbles.ts';
import type { MissiveClientOptions } from '../clients/missive.ts';
import { MissiveError, postConversationComment, postInboundMessage } from '../clients/missive.ts';
import { config } from '../config.ts';
import type { Db } from '../db.ts';
import { getCaps } from '../domain/capability.ts';
import { resolveName } from '../domain/identity.ts';
import type { InboundCtx } from '../domain/inbound.ts';
import { planInbound, planReceiptComment } from '../domain/inbound.ts';
import type { OutboundCtx } from '../domain/outbound.ts';
import { dmChatGuid, planOutbound } from '../domain/outbound.ts';
import type { Logger } from '../logger.ts';
import type {
  BbMessage,
  BbWebhook,
  InboundPost,
  MissiveInboundBody,
  MissiveOutAttachment,
  MissiveOutboundWebhook,
  OutboxKind,
  OutboxRow,
  Service,
} from '../types.ts';
import { backoffMs } from '../util.ts';
import type { Limiter } from './ratelimiter.ts';

/** Maximum delivery attempts before a job is dead-lettered. */
export const MAX_ATTEMPTS = 8;

/** Echo-suppression recency window (ms) — matches invariant #5's ~5 minutes. */
const ECHO_WINDOW_MS = 5 * 60 * 1000;

/** Default jobs claimed per drain pass. */
const DEFAULT_BATCH_SIZE = 20;

/** Default idle poll interval (ms) for the background loop. */
const DEFAULT_POLL_MS = 1000;

/** Everything the worker needs, injected for testability. */
export interface WorkerDeps {
  /** The database (mappings, outbox, sent_map). */
  db: Db;
  /** Missive rate limiter governing REST calls. */
  limiter: Limiter;
  /** Leveled logger. */
  logger: Logger;
  /** Max attempts before dead-lettering (defaults to {@link MAX_ATTEMPTS}). */
  maxAttempts?: number;
  /** Batch size per drain pass. */
  batchSize?: number;
  /** Poll interval (ms) when idle. */
  pollMs?: number;
  /** Surface delivered/read receipts as Posts comments (defaults to config). */
  receiptsAsPosts?: boolean;
  /** Override fetch for the underlying clients (tests). */
  fetch?: typeof fetch;
}

/** A running worker handle. */
export interface Worker {
  /** Stop the worker; resolves once the in-flight pass settles. */
  stop(): Promise<void>;
}

/** How a failed dispatch should be handled. */
interface FailureClass {
  /** Whether the error is transient (retry) vs permanent (dead-letter). */
  retryable: boolean;
  /** Exact reschedule delay (ms) when the upstream dictated one (429). */
  retryAfterMs?: number;
}

/** Build per-call BlueBubbles client options, threading the fetch override. */
function bbOptions(deps: WorkerDeps): BbClientOptions {
  return deps.fetch ? { fetch: deps.fetch } : {};
}

/** Build per-call Missive client options, threading the fetch override. */
function missiveOptions(deps: WorkerDeps): MissiveClientOptions {
  return deps.fetch ? { fetch: deps.fetch } : {};
}

/** Compact attachment signature (count-based) for echo correlation (#5). */
function attachmentSig(count: number): string {
  return `att:${count}`;
}

/**
 * Decode a Missive outbound attachment's inline bytes into a `File`.
 *
 * @throws {BbError} Permanent error when the webhook carries no inline bytes
 *   (the worker dead-letters rather than texting an empty message).
 */
function attachmentFile(att: MissiveOutAttachment): File {
  if (!att.base64_data) {
    throw new BbError('outbound attachment has no inline bytes', false);
  }
  const filename = att.filename ?? 'attachment';
  const bytes = Buffer.from(att.base64_data, 'base64');
  return new File([bytes], filename, att.media_type ? { type: att.media_type } : {});
}

/** Build a `message/attachment` multipart form for one attachment (field `attachment`). */
function attachmentForm(att: MissiveOutAttachment, chatGuid: string, tempGuid: string): FormData {
  const file = attachmentFile(att);
  const form = new FormData();
  form.append('chatGuid', chatGuid);
  form.append('tempGuid', tempGuid);
  form.append('name', att.filename ?? 'attachment');
  form.append('attachment', file);
  return form;
}

/** Build a bare `attachment/upload` form (Private-API multipart pre-upload). */
function uploadForm(att: MissiveOutAttachment): FormData {
  const file = attachmentFile(att);
  const form = new FormData();
  form.append('name', att.filename ?? 'attachment');
  form.append('attachment', file);
  return form;
}

/**
 * Resolve the delivery service for a brand-new 1:1 conversation. When the
 * Private API is available and the default service is iMessage, probe per-
 * recipient iMessage availability and fall back to SMS for a number that can't
 * receive iMessage. A failed/unavailable probe never blocks the send.
 */
async function resolveNewChatService(
  address: string,
  privateApi: boolean,
  deps: WorkerDeps,
): Promise<Service> {
  const fallback = config.DEFAULT_SERVICE;
  if (privateApi && fallback === 'iMessage') {
    try {
      if (!(await handleAvailabilityImessage(address, bbOptions(deps)))) {
        deps.logger.info('recipient not reachable on iMessage; using SMS fallback', { address });
        return 'SMS';
      }
    } catch {
      // Availability probe failed -> keep the default service (never block a send).
    }
  }
  return fallback;
}

/**
 * Send an attachment message. With the Private API and a caption or multiple
 * files this uploads each attachment and emits ONE `message/multipart` (mixed
 * text+media, full fidelity). Without it, each attachment is its own apple-
 * script `message/attachment` and any caption follows as its own `message/text`
 * — each sub-send recorded with its own tempGuid so BlueBubbles' sendCache
 * dedups a retry (invariant #8) and the inbound echo of each is suppressed (#5).
 * Nothing the agent sent is silently dropped.
 */
async function dispatchAttachmentSend(
  hook: MissiveOutboundWebhook,
  chatGuid: string,
  tempGuid: string,
  privateApi: boolean,
  record: boolean,
  deps: WorkerDeps,
): Promise<void> {
  const { db } = deps;
  const opts = bbOptions(deps);
  const missiveMsgId = hook.message.id;
  const atts = hook.message.attachments ?? [];
  const caption = hook.message.body;

  // Private-API multipart: one message carrying the caption + every attachment.
  if (privateApi && (atts.length > 1 || (atts.length >= 1 && caption !== undefined))) {
    const parts: Array<{ type: 'text'; text: string } | { type: 'attachment'; guid: string }> = [];
    if (caption !== undefined) parts.push({ type: 'text', text: caption });
    for (const att of atts) {
      const uploaded = await uploadAttachment(uploadForm(att), opts);
      parts.push({ type: 'attachment', guid: uploaded.guid });
    }
    if (record) {
      db.recordSend({
        tempGuid,
        chatGuid,
        missiveMsgId,
        text: caption ?? null,
        attSig: attachmentSig(atts.length),
      });
    }
    const sent = await sendMultipart({ chatGuid, tempGuid, parts }, opts);
    db.setSendBbGuid(tempGuid, sent.guid);
    return;
  }

  // Apple-script path: first attachment uses the primary tempGuid.
  const firstForm = attachmentForm(atts[0] as MissiveOutAttachment, chatGuid, tempGuid);
  if (record) {
    db.recordSend({ tempGuid, chatGuid, missiveMsgId, text: null, attSig: attachmentSig(1) });
  }
  const sent = await sendAttachment(firstForm, opts);
  db.setSendBbGuid(tempGuid, sent.guid);

  // Extra attachments (no multipart) -> one recorded apple-script send each.
  for (const [j, att] of atts.slice(1).entries()) {
    const subGuid = `${tempGuid}:att${j + 1}`;
    const form = attachmentForm(att, chatGuid, subGuid);
    if (record) {
      db.recordSend({
        tempGuid: subGuid,
        chatGuid,
        missiveMsgId: `${missiveMsgId}:att${j + 1}`,
        text: null,
        attSig: attachmentSig(1),
      });
    }
    const extra = await sendAttachment(form, opts);
    db.setSendBbGuid(subGuid, extra.guid);
  }

  // Preserve the caption as its own recorded text message (echo suppressed by text).
  if (caption !== undefined) {
    const capGuid = `${tempGuid}:cap`;
    if (record) {
      db.recordSend({
        tempGuid: capGuid,
        chatGuid,
        missiveMsgId: `${missiveMsgId}:cap`,
        text: caption,
        attSig: null,
      });
    }
    const cap = await sendText(
      { chatGuid, tempGuid: capGuid, message: caption, method: 'apple-script' },
      opts,
    );
    db.setSendBbGuid(capGuid, cap.guid);
  }
}

/** Dispatch a `bb_send` job: plan the send, record it, perform the send op(s). */
async function dispatchBbSend(job: OutboxRow, deps: WorkerDeps): Promise<void> {
  const { db, logger } = deps;
  const opts = bbOptions(deps);
  const hook = job.payload as MissiveOutboundWebhook;
  const missiveMsgId = hook.message.id;
  const existing = db.getSendByMissiveId(missiveMsgId);
  // On retry the sends were already recorded; re-derive the same tempGuids and
  // re-send (sendCache dedups) without re-recording (PK conflict / double row).
  const record = !existing;
  const caps = getCaps();

  const ctx: OutboundCtx = {
    defaultService: config.DEFAULT_SERVICE,
    privateApi: caps.privateApi,
    // Reuse the recorded tempGuid on retry (invariant #8); mint a fresh one otherwise.
    newTempGuid: () => existing?.temp_guid ?? crypto.randomUUID(),
    getChatGuidByConversation: (convId) => db.getChatByConversation(convId)?.chat_guid ?? null,
    // `planOutbound` passes the already-parsed chat guid (from the `bb-chat-<guid>`
    // token); this resolver only verifies it maps to a known chat. (Re-parsing the
    // token here was a bug: it always yielded null, so reply-by-reference never
    // resolved and silently forked a new conversation.)
    resolveChatByReference: (chatGuid) => (db.getChatByGuid(chatGuid) ? chatGuid : null),
    resolveDmChatGuid: (address) => {
      const guid = dmChatGuid(address);
      return db.getChatByGuid(guid) ? guid : null;
    },
  };

  const plan = planOutbound(hook, ctx);
  const chatGuid = plan.send.op === 'chat/new' ? null : plan.send.chatGuid;

  // Bind the Missive conversation id onto an already-resolved chat (invariant #6).
  if (chatGuid !== null && hook.conversation?.id) {
    const row = db.getChatByGuid(chatGuid);
    if (row && row.conversation_id === null) {
      db.bindConversation(chatGuid, hook.conversation.id);
    }
  }

  switch (plan.send.op) {
    case 'message/text': {
      // Record before sending so a crash mid-send still suppresses the echo and
      // reuses this exact tempGuid; on retry the row already exists, so skip it.
      if (record) {
        db.recordSend({ tempGuid: plan.tempGuid, chatGuid, missiveMsgId, text: plan.text ?? null });
      }
      const sent = await sendText(
        {
          chatGuid: plan.send.chatGuid,
          tempGuid: plan.tempGuid,
          message: plan.text ?? '',
          method: 'apple-script',
        },
        opts,
      );
      db.setSendBbGuid(plan.tempGuid, sent.guid);
      break;
    }
    case 'message/attachment': {
      await dispatchAttachmentSend(
        hook,
        plan.send.chatGuid,
        plan.tempGuid,
        caps.privateApi,
        record,
        deps,
      );
      break;
    }
    case 'chat/new': {
      if (record) {
        db.recordSend({
          tempGuid: plan.tempGuid,
          chatGuid: null,
          missiveMsgId,
          text: plan.text ?? null,
        });
      }
      const addresses = plan.send.addresses;
      // Groups (multiple recipients) can only be created over the Private API.
      const method: BbMethod = addresses.length > 1 ? 'private-api' : 'apple-script';
      // Per-recipient SMS fallback for a brand-new 1:1 (Private-API gated).
      const single = addresses.length === 1 ? addresses[0] : undefined;
      const service =
        single !== undefined
          ? await resolveNewChatService(single, caps.privateApi, deps)
          : config.DEFAULT_SERVICE;
      const created = await chatNew(
        {
          addresses,
          service,
          method,
          tempGuid: plan.tempGuid,
          ...(plan.text !== undefined ? { message: plan.text } : {}),
        },
        opts,
      );
      // Mint the chat<->conversation mapping so later inbound binds (invariant #6).
      db.mapChat(created.guid, `bb-chat-${created.guid}`, hook.conversation?.id ?? null);
      // Backfill the now-known chat guid onto the send so this conversation's
      // own first-message echo (which arrives with the real chat guid, not the
      // null we recorded pre-send) is consumed and dropped (invariant #3 / #5).
      db.setSendChatGuid(plan.tempGuid, created.guid);
      break;
    }
  }

  logger.debug('bb_send dispatched', { jobId: job.id, op: plan.send.op, tempGuid: plan.tempGuid });
}

/**
 * Download each referenced attachment and inline it as base64 into the post's
 * Missive body (positionally aligned with the body's attachment slots).
 */
async function fillAttachments(post: InboundPost, deps: WorkerDeps): Promise<MissiveInboundBody> {
  const refs = post.attachmentRefs ?? [];
  if (refs.length === 0) return post.body;

  const opts = bbOptions(deps);
  const encoded = await Promise.all(
    refs.map(async (guid) => {
      const bytes = await downloadAttachment(guid, { original: config.ATTACHMENT_ORIGINAL }, opts);
      return Buffer.from(bytes).toString('base64');
    }),
  );

  const slots = post.body.messages.attachments ?? [];
  const attachments = slots.map((slot, i) =>
    i < encoded.length ? { filename: slot.filename, base64_data: encoded[i] as string } : slot,
  );
  return { messages: { ...post.body.messages, attachments } };
}

/** Attachment signature of an inbound message echo (count-based), or null. */
function echoAttSig(data: BbMessage): string | null {
  const n = data.attachments?.length ?? 0;
  return n > 0 ? attachmentSig(n) : null;
}

/**
 * Populate `handle_map` for a contact's address so the inbound post renders a
 * display name (handle/query -> contact/query, cached). Name resolution never
 * blocks delivery: {@link resolveName} degrades to the raw address on any error.
 */
async function cacheSenderName(data: BbMessage, deps: WorkerDeps): Promise<void> {
  const address = data.handle?.address;
  if (!address) return;
  await resolveName(address, {
    getCachedName: (a) => deps.db.getHandle(a)?.name ?? null,
    cacheName: (a, name) => deps.db.upsertHandle(a, name),
    ...(deps.fetch ? { client: { fetch: deps.fetch } } : {}),
  });
}

/** Mark the outbound send a `message-send-error` refers to as `failed` (flow A.4). */
function markSendFailed(data: unknown, db: Db, logger: Logger): void {
  const d = (data ?? {}) as { tempGuid?: unknown; guid?: unknown };
  let tempGuid: string | null = null;
  if (typeof d.tempGuid === 'string') {
    tempGuid = d.tempGuid;
  } else if (typeof d.guid === 'string') {
    tempGuid = db.findEchoByBbGuid(d.guid)?.temp_guid ?? null;
  }
  if (tempGuid) {
    db.markSendStatus(tempGuid, 'failed');
    logger.warn('outbound send marked failed', { tempGuid });
  } else {
    logger.warn('message-send-error with no matching send');
  }
}

/** Dispatch a `missive_post` job: suppress echoes, then post the planned bodies. */
async function dispatchMissivePost(job: OutboxRow, deps: WorkerDeps): Promise<void> {
  const { db, limiter, logger } = deps;
  const evt = job.payload as BbWebhook;
  const receiptsAsPosts = deps.receiptsAsPosts ?? config.RECEIPTS_AS_POSTS;

  // message-send-error: surface the failure by marking the matching send failed.
  if (evt.type === 'message-send-error') {
    markSendFailed(evt.data, db, logger);
    return;
  }

  // Cache the message + suppress our own echoes before planning (invariant #5).
  if (evt.type === 'new-message') {
    const data = evt.data as BbMessage;
    const chatGuid = data.chats?.[0]?.guid ?? null;
    if (chatGuid) {
      db.cacheMessage(data.guid, chatGuid, data.text, data.isFromMe);
      db.mapChat(chatGuid, `bb-chat-${chatGuid}`);
      if (data.isFromMe) {
        const echo = db.consumeEcho({
          chatGuid,
          text: data.text,
          attSig: echoAttSig(data),
          bbGuid: data.guid,
          sinceMs: db.now() - ECHO_WINDOW_MS,
        });
        if (echo) {
          logger.debug('echo suppressed', { jobId: job.id, bbGuid: data.guid });
          return;
        }
      } else {
        // Genuine inbound: resolve + cache the sender's display name (identity).
        await cacheSenderName(data, deps);
      }
    }
  }

  const ctx: InboundCtx = {
    accountId: config.MISSIVE_ACCOUNT_ID,
    selfHandle: config.SELF_HANDLE,
    selfName: config.SELF_NAME,
    maxPayloadBytes: config.MISSIVE_MAX_PAYLOAD_BYTES,
    receiptsAsPosts,
    caps: getCaps(),
    lookupChatForMessage: (guid) => db.lookupChatForMessage(guid),
    getMessageText: (guid) => db.getMessageText(guid),
    resolveName: (address) => db.getHandle(address)?.name ?? address,
    getConversationId: (guid) => db.getChatByGuid(guid)?.conversation_id ?? null,
  };

  const opts = missiveOptions(deps);

  // RECEIPTS_AS_POSTS: surface a delivered/read receipt as a conversation comment.
  const receipt = planReceiptComment(evt, ctx);
  if (receipt) {
    await limiter.run(() => postConversationComment(receipt, opts));
    logger.debug('receipt posted as comment', { jobId: job.id });
    return;
  }

  const posts = planInbound(evt, ctx);
  for (const post of posts) {
    const externalId = post.body.messages.external_id;
    // A split message is many sub-posts; skip any already delivered on a prior
    // attempt so a partial failure re-posts only the unfinished sub-post (#7).
    if (externalId !== undefined && db.isPostDelivered(externalId)) {
      logger.debug('sub-post already delivered; skipping on retry', { jobId: job.id, externalId });
      continue;
    }
    const body = await fillAttachments(post, deps);
    await limiter.run(() => postInboundMessage(body, opts));
    if (externalId !== undefined) db.markPostDelivered(externalId);
  }

  logger.debug('missive_post dispatched', { jobId: job.id, posts: posts.length });
}

/** Execute a single claimed job (the side effect for its `kind`). */
export function dispatch(job: OutboxRow, deps: WorkerDeps): Promise<void> {
  if (job.kind === 'bb_send') return dispatchBbSend(job, deps);
  return dispatchMissivePost(job, deps);
}

/** Classify a dispatch error into retry-vs-dead-letter (+ any forced delay). */
function classifyError(err: unknown): FailureClass {
  if (err instanceof MissiveError) {
    if (err.permanent) return { retryable: false };
    return err.retryAfterMs !== undefined
      ? { retryable: true, retryAfterMs: err.retryAfterMs }
      : { retryable: true };
  }
  if (err instanceof BbError) return { retryable: err.retryable };
  // Unknown errors are treated as transient (bounded by MAX_ATTEMPTS).
  return { retryable: true };
}

/** Reschedule (with backoff / Retry-After) or dead-letter a failed job. */
function handleFailure(job: OutboxRow, err: unknown, deps: WorkerDeps, maxAttempts: number): void {
  const { db, logger } = deps;
  const attempts = job.attempts + 1;
  const cls = classifyError(err);
  const message = err instanceof Error ? err.message : String(err);

  if (!cls.retryable || attempts >= maxAttempts) {
    db.markDead(job.id, message);
    logger.warn('job dead-lettered', { jobId: job.id, attempts, error: message });
    return;
  }

  const delay = cls.retryAfterMs ?? backoffMs(attempts);
  db.reschedule(job.id, attempts, db.now() + delay, message);
  logger.warn('job rescheduled', { jobId: job.id, attempts, delayMs: delay });
}

/**
 * Run one drain pass: claim due jobs (barrier-aware), dispatch them under the
 * limiter, and reschedule / dead-letter on failure.
 *
 * @returns The number of jobs processed in this pass.
 */
export async function drainOutbox(deps: WorkerDeps): Promise<number> {
  const { db, logger } = deps;
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const jobs = db.claimDueJobs(db.now(), batchSize);

  await Promise.all(
    jobs.map(async (job) => {
      try {
        await dispatch(job, deps);
        db.markDone(job.id);
      } catch (err) {
        handleFailure(job, err, deps, maxAttempts);
      }
    }),
  );

  if (jobs.length > 0) logger.debug('drain pass complete', { processed: jobs.length });
  return jobs.length;
}

/**
 * Start the background drain loop; returns a handle to stop it.
 *
 * A reentrancy guard makes the poll loop skip any tick that fires while the
 * previous pass is still in flight: a slow dispatch (a 60s attachment download,
 * a rate-limiter-parked POST) can outlast `pollMs`, and without the guard the
 * next tick would start a second `drainOutbox` concurrently. Because at most one
 * pass runs at a time, `inFlight` always references the only in-flight drain, so
 * `stop()` awaiting it never leaves an orphaned dispatch racing teardown.
 */
export function startWorker(deps: WorkerDeps): Worker {
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  let inFlight: Promise<unknown> = Promise.resolve();
  let draining = false;

  const tick = (): void => {
    if (draining) return; // a previous pass is still running; skip this tick.
    draining = true;
    inFlight = drainOutbox(deps)
      .catch((err) => {
        deps.logger.error('drain pass failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        draining = false;
      });
  };

  const timer = setInterval(tick, pollMs);
  // Don't keep the process alive solely for the poll loop.
  timer.unref?.();

  return {
    stop: async (): Promise<void> => {
      clearInterval(timer);
      await inFlight;
    },
  };
}

/** Build a durable job and enqueue it (thin wrapper over {@link Db.enqueue}). */
export function enqueueJob(
  db: Db,
  kind: OutboxKind,
  chatGuid: string | null,
  payload: unknown,
): void {
  db.enqueue({ kind, chat_guid: chatGuid, payload });
}
