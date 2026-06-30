/**
 * Inbound mapping (BlueBubbles event -> Missive).
 *
 * PURE: turn one BlueBubbles webhook event into zero-or-more fully-built Missive
 * inbound posts, with attachment packing/splitting + tapback/edit/unsend/group
 * rendering. No network here — attachment bytes are NOT fetched. The planner
 * returns the Missive bodies plus the attachment guids the worker must download
 * and inline as base64 before posting.
 *
 * Invariants enforced here:
 *  - #8: every post carries `references=['bb-chat-<chatGuid>']`.
 *  - #7: `external_id='bb-msg-<guid>'`, with a `:text`/`:att<n>` suffix when one
 *    BB message splits across multiple posts (each its own outbox job).
 *  - #6: `conversation=<chat_map.conversation_id>` is bound when known.
 *
 * Echo suppression (#5) is applied by the worker via `consumeEcho` BEFORE this
 * planner is invoked, so `planInbound` never re-checks for echoes.
 */

import type {
  BbAttachment,
  BbMessage,
  BbWebhook,
  Caps,
  InboundPost,
  MissiveField,
  MissiveInboundAttachment,
  MissiveInboundMessage,
} from '../types.ts';
import { msToUnix } from '../util.ts';

/** Apple tapback association type -> rendered verb. */
export const TAPBACK_VERBS: Readonly<Record<number, string>> = {
  2000: 'loved',
  2001: 'liked',
  2002: 'disliked',
  2003: 'laughed at',
  2004: 'emphasized',
  2005: 'questioned',
  3000: 'removed a love from',
  3001: 'removed a like from',
  3002: 'removed a dislike from',
  3003: 'removed a laugh from',
  3004: 'removed an emphasis from',
  3005: 'removed a question from',
};

/** Read-side context the pure planner needs (all synchronous lookups). */
export interface InboundCtx {
  /** REQUIRED Missive channel id (inbound `account`). */
  readonly accountId: string;
  /** The Mac's own iMessage address (inbound `to_fields[0]`). */
  readonly selfHandle: string;
  /** Display name for the bridge's own identity. */
  readonly selfName: string;
  /** Max single-POST body size; drives attachment packing/splitting. */
  readonly maxPayloadBytes: number;
  /** If true, surface delivered/read receipts as Posts comments. */
  readonly receiptsAsPosts: boolean;
  /** Current capability snapshot. */
  readonly caps: Caps;
  /** Resolve the chat guid for a previously-seen message guid. */
  lookupChatForMessage(bbGuid: string): string | null;
  /** Resolve the target text for a previously-seen message guid (tapbacks/edits). */
  getMessageText(bbGuid: string): string | null;
  /** Resolve a cached display name for an address (no network). */
  resolveName(address: string): string;
  /** Resolve a bound Missive conversation id for a chat, when known. */
  getConversationId(chatGuid: string): string | null;
}

/**
 * Fixed byte budget reserved for the JSON envelope (account, fields, references,
 * external_id, etc.) so packing never overruns the hard payload cap.
 */
const OVERHEAD_BYTES = 4096;

/** Per-attachment JSON overhead (filename + key punctuation) when packing. */
const ATTACHMENT_OVERHEAD_BYTES = 128;

/** Max characters of a target/original message quoted inline (tapbacks, unsends). */
const SNIPPET_MAX = 120;

/** Internal: one planned Missive post before external_id suffixing is finalized. */
interface PostDraft {
  /** Suffix appended to `bb-msg-<guid>` when the message splits (`''` if single). */
  suffix: string;
  /** Optional rendered text body. */
  body?: string;
  /** Attachments carried by this post (filename + BB guid to fetch). */
  attachments: Array<{ filename: string; ref: string }>;
}

/** Length (in characters) of the base64 encoding of `bytes` raw bytes. */
function base64Len(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** UTF-8 byte length of a string. */
function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Human-readable byte size for oversized-attachment placeholders. */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** Truncate a string to {@link SNIPPET_MAX} characters with an ellipsis. */
function truncate(s: string): string {
  return s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX)}…` : s;
}

/** Best display filename for an attachment (transferName, else a guid fallback). */
function attFilename(att: BbAttachment): string {
  const n = att.transferName;
  return n != null && n.trim() !== '' ? n : `attachment-${att.guid}`;
}

/** Placeholder line for an attachment too large to inline under the cap. */
function placeholderLine(att: BbAttachment): string {
  return `📎 ${attFilename(att)} (${humanBytes(att.totalBytes ?? 0)}) — too large to inline`;
}

/** The bridge's own identity field (used as the system-line author). */
function selfField(ctx: InboundCtx): MissiveField {
  return { id: ctx.selfHandle, name: ctx.selfName };
}

/** Resolve the `from_field` for a message: self when from me, else the contact. */
function senderField(data: BbMessage, chatGuid: string, ctx: InboundCtx): MissiveField {
  if (data.isFromMe) return selfField(ctx);
  const address = data.handle?.address ?? chatGuid;
  return { id: address, name: ctx.resolveName(address) };
}

/** Derive a conversation subject from a chat's display name, when present. */
function chatSubject(data: BbMessage): string | null {
  const dn = data.chats?.[0]?.displayName;
  return dn != null && dn.trim() !== '' ? dn : null;
}

/** Compute Missive `delivered_at`/`created_at` (Unix seconds) from a message. */
function timestamps(data: BbMessage): { deliveredAt?: number; createdAt?: number } {
  const out: { deliveredAt?: number; createdAt?: number } = {};
  if (data.dateCreated != null) out.createdAt = msToUnix(data.dateCreated);
  const delivered = data.dateDelivered ?? data.dateCreated;
  if (delivered != null) out.deliveredAt = msToUnix(delivered);
  return out;
}

/** Options accepted by {@link buildPost}. */
interface BuildOpts {
  body?: string;
  attachments?: ReadonlyArray<{ filename: string; ref: string }>;
  subject?: string | null;
  deliveredAt?: number;
  createdAt?: number;
}

/**
 * Assemble a single {@link InboundPost} — the fully-built Missive body plus the
 * BB attachment guids the worker must download and inline as base64.
 */
function buildPost(
  ctx: InboundCtx,
  chatGuid: string,
  fromField: MissiveField,
  externalId: string,
  opts: BuildOpts,
): InboundPost {
  const conversation = ctx.getConversationId(chatGuid);
  const inbAtts: MissiveInboundAttachment[] | undefined = opts.attachments?.map((a) => ({
    filename: a.filename,
    base64_data: '',
  }));
  const refs = opts.attachments?.map((a) => a.ref);
  const messages: MissiveInboundMessage = {
    account: ctx.accountId,
    from_field: fromField,
    to_fields: [selfField(ctx)],
    references: [`bb-chat-${chatGuid}`],
    external_id: externalId,
    ...(opts.body !== undefined && opts.body !== '' ? { body: opts.body } : {}),
    ...(inbAtts && inbAtts.length > 0 ? { attachments: inbAtts } : {}),
    ...(conversation ? { conversation } : {}),
    ...(opts.subject ? { conversation_subject: opts.subject } : {}),
    ...(opts.deliveredAt !== undefined ? { delivered_at: opts.deliveredAt } : {}),
    ...(opts.createdAt !== undefined ? { created_at: opts.createdAt } : {}),
  };
  return {
    body: { messages },
    ...(refs && refs.length > 0 ? { attachmentRefs: refs } : {}),
  };
}

/** Render a tapback (`new-message` carrying an `associatedMessageType`) as text. */
function planTapback(
  data: BbMessage,
  chatGuid: string,
  assocType: number,
  ctx: InboundCtx,
): InboundPost[] {
  const verb = TAPBACK_VERBS[assocType];
  if (!verb) return [];
  const fromField = senderField(data, chatGuid, ctx);
  const reactor = fromField.name ?? fromField.id;
  const targetGuid = data.associatedMessageGuid ?? null;
  const targetText = targetGuid ? ctx.getMessageText(targetGuid) : null;
  const target = targetText ? `"${truncate(targetText)}"` : 'a message';
  const ts = timestamps(data);
  return [
    buildPost(ctx, chatGuid, fromField, `bb-msg-${data.guid}`, {
      body: `${reactor} ${verb} ${target}`,
      ...ts,
    }),
  ];
}

/**
 * Render a normal `new-message` (text and/or attachments) into one-or-more
 * Missive posts, packing under {@link InboundCtx.maxPayloadBytes} and splitting
 * with unique `external_id` suffixes when it cannot fit in a single POST.
 */
function planMessagePosts(data: BbMessage, chatGuid: string, ctx: InboundCtx): InboundPost[] {
  const text = data.text ?? '';
  const atts = data.attachments ?? [];
  const fromField = senderField(data, chatGuid, ctx);
  const subject = chatSubject(data);
  const ts = timestamps(data);
  const budget = ctx.maxPayloadBytes - OVERHEAD_BYTES;

  const fitting: Array<{ index: number; size: number; filename: string; ref: string }> = [];
  const oversize: Array<{ index: number; att: BbAttachment }> = [];
  for (const [i, att] of atts.entries()) {
    const b64 = base64Len(att.totalBytes ?? 0);
    if (b64 + ATTACHMENT_OVERHEAD_BYTES > budget) {
      oversize.push({ index: i, att });
    } else {
      fitting.push({
        index: i,
        size: b64 + ATTACHMENT_OVERHEAD_BYTES,
        filename: attFilename(att),
        ref: att.guid,
      });
    }
  }

  const hasText = text.trim() !== '';
  const textSize = byteLen(text);
  const fittingTotal = fitting.reduce((s, f) => s + f.size, 0);
  const singleFits =
    oversize.length === 0 && OVERHEAD_BYTES + textSize + fittingTotal <= ctx.maxPayloadBytes;

  const drafts: PostDraft[] = [];
  if (singleFits && (hasText || fitting.length > 0)) {
    drafts.push({
      suffix: '',
      ...(hasText ? { body: text } : {}),
      attachments: fitting.map((f) => ({ filename: f.filename, ref: f.ref })),
    });
  } else {
    if (hasText) drafts.push({ suffix: ':text', body: text, attachments: [] });
    let open: PostDraft | null = null;
    let openSize = 0;
    for (const f of fitting) {
      if (open && openSize + f.size <= budget) {
        open.attachments.push({ filename: f.filename, ref: f.ref });
        openSize += f.size;
      } else {
        open = { suffix: `:att${f.index}`, attachments: [{ filename: f.filename, ref: f.ref }] };
        openSize = f.size;
        drafts.push(open);
      }
    }
    for (const o of oversize) {
      drafts.push({ suffix: `:att${o.index}`, body: placeholderLine(o.att), attachments: [] });
    }
  }

  if (drafts.length === 0) return [];
  const single = drafts.length === 1;
  return drafts.map((d) =>
    buildPost(ctx, chatGuid, fromField, `bb-msg-${data.guid}${single ? '' : d.suffix}`, {
      ...(d.body !== undefined ? { body: d.body } : {}),
      attachments: d.attachments,
      subject,
      ...ts,
    }),
  );
}

/** Plan posts for a `new-message` event (tapback vs. ordinary text/attachments). */
function planNewMessage(data: BbMessage, ctx: InboundCtx): InboundPost[] {
  const chatGuid = data.chats?.[0]?.guid;
  if (!chatGuid) return [];
  const assocType = data.associatedMessageType == null ? 0 : Number(data.associatedMessageType);
  if (assocType !== 0) return planTapback(data, chatGuid, assocType, ctx);
  return planMessagePosts(data, chatGuid, ctx);
}

/** Plan posts for an `updated-message` event (edit / unsend; receipts are no-ops). */
function planUpdatedMessage(data: BbMessage, ctx: InboundCtx): InboundPost[] {
  const chatGuid = ctx.lookupChatForMessage(data.guid);
  if (!chatGuid) return [];
  const fromField = senderField(data, chatGuid, ctx);
  const ts = timestamps(data);
  if (data.dateRetracted != null) {
    const original = ctx.getMessageText(data.guid);
    const line = original ? `🚫 Unsent: "${truncate(original)}"` : '🚫 Unsent a message';
    return [
      buildPost(ctx, chatGuid, fromField, `bb-msg-${data.guid}:unsend${data.dateRetracted}`, {
        body: line,
        ...ts,
      }),
    ];
  }
  if (data.dateEdited != null) {
    const newText = data.text ?? '';
    const line = newText ? `✏️ Edited: ${newText}` : '✏️ Edited the message';
    return [
      buildPost(ctx, chatGuid, fromField, `bb-msg-${data.guid}:edit${data.dateEdited}`, {
        body: line,
        ...ts,
      }),
    ];
  }
  return [];
}

/** Plan a single system-line post for a group/participant event, binding subject. */
function planGroupEvent(type: string, data: BbMessage, ctx: InboundCtx): InboundPost[] {
  const chatGuid = data.chats?.[0]?.guid ?? ctx.lookupChatForMessage(data.guid);
  if (!chatGuid) return [];
  const actor = data.isFromMe ? ctx.selfName : ctx.resolveName(data.handle?.address ?? chatGuid);
  let line: string;
  let subject: string | null = null;
  switch (type) {
    case 'group-name-change': {
      const name = data.groupTitle ?? '';
      subject = name !== '' ? name : null;
      line = name ? `${actor} named the conversation "${name}"` : `${actor} named the conversation`;
      break;
    }
    case 'group-icon-changed':
      line = `${actor} changed the group photo`;
      break;
    case 'group-icon-removed':
      line = `${actor} removed the group photo`;
      break;
    case 'participant-added':
      line = `${actor} added someone to the conversation`;
      break;
    case 'participant-removed':
      line = `${actor} removed someone from the conversation`;
      break;
    case 'participant-left':
      line = `${actor} left the conversation`;
      break;
    default:
      line = `${actor} updated the conversation`;
      break;
  }
  const externalId = data.guid ? `bb-msg-${data.guid}` : `bb-grp-${chatGuid}`;
  return [
    buildPost(ctx, chatGuid, selfField(ctx), externalId, {
      body: line,
      subject,
      ...timestamps(data),
    }),
  ];
}

/** A receipt rendered as a Missive Posts-API conversation comment. */
export interface ReceiptComment {
  /** The bound Missive conversation to append the comment to. */
  readonly conversationId: string;
  /** The comment text (e.g. `✓ Delivered`, `✓✓ Read`). */
  readonly text: string;
}

/**
 * Plan a delivered/read receipt as a conversation comment, when
 * `RECEIPTS_AS_POSTS` is enabled (Missive has no message status-patch API, so a
 * Posts comment is the only way to surface a receipt). Returns `null` unless the
 * event is a genuine receipt for a chat already bound to a Missive conversation
 * — edits/unsends, unbound chats, and every other event fall through to
 * {@link planInbound}.
 *
 * @param evt - The BlueBubbles webhook event.
 * @param ctx - Read-side context (reads {@link InboundCtx.receiptsAsPosts}).
 */
export function planReceiptComment(evt: BbWebhook, ctx: InboundCtx): ReceiptComment | null {
  if (!ctx.receiptsAsPosts) return null;

  if (evt.type === 'chat-read-status-changed') {
    const d = (evt.data ?? {}) as { chatGuid?: string };
    if (!d.chatGuid) return null;
    const conversationId = ctx.getConversationId(d.chatGuid);
    return conversationId ? { conversationId, text: '✓✓ Read' } : null;
  }

  if (evt.type === 'updated-message') {
    const data = (evt.data ?? {}) as BbMessage;
    // Edits/unsends are rendered as messages by planInbound, not receipts.
    if (data.dateEdited != null || data.dateRetracted != null) return null;
    const chatGuid = ctx.lookupChatForMessage(data.guid);
    if (!chatGuid) return null;
    const conversationId = ctx.getConversationId(chatGuid);
    if (!conversationId) return null;
    if (data.dateRead != null) return { conversationId, text: '✓✓ Read' };
    if (data.isDelivered) return { conversationId, text: '✓ Delivered' };
  }

  return null;
}

/**
 * Plan the Missive post(s) for one BlueBubbles event.
 *
 * @returns Zero or more {@link InboundPost}s; empty when the event is dropped
 *   (e.g. typing, receipts, no-op delivered/read updates, unroutable events).
 */
export function planInbound(evt: BbWebhook, ctx: InboundCtx): InboundPost[] {
  const data = (evt.data ?? {}) as BbMessage;
  switch (evt.type) {
    case 'new-message':
      return planNewMessage(data, ctx);
    case 'updated-message':
      return planUpdatedMessage(data, ctx);
    default:
      if (evt.type.startsWith('group-') || evt.type.startsWith('participant-')) {
        return planGroupEvent(evt.type, data, ctx);
      }
      return [];
  }
}
