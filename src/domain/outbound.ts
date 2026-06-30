/**
 * Outbound mapping (Missive -> BlueBubbles).
 *
 * PURE: turn a Missive outbound webhook into a single BlueBubbles {@link SendPlan}.
 *
 * Resolution precedence (plan flow A, step 3 + invariant #4):
 *  1. `chat_map` by `conversation.id`            -> `reply-known-chat`
 *  2. a `bb-chat-<guid>` token in `message.references[]` that resolves to a
 *     known chat                                  -> `reply-by-reference`
 *  3. a single recipient whose existing 1:1 chat resolves
 *                                                 -> `reply-known-chat`
 *  4. otherwise create a conversation             -> `new-conversation`
 *     (one recipient = 1:1; many = group, which requires the Private API).
 *
 * The planner emits EXACTLY ONE send op (invariant #3): a known chat yields a
 * single `/message/text` or `/message/attachment`; a new conversation yields a
 * single `/chat/new` carrying the body (never *also* a `/message/text`). It
 * mints a `tempGuid` recorded in `sent_map` before the send and reused verbatim
 * on retry so BlueBubbles' sendCache dedups a crash-after-deliver (invariant #8).
 */

import type {
  MissiveOutboundWebhook,
  OutboundResolution,
  SendOp,
  SendPlan,
  Service,
} from '../types.ts';

/** Chat-level reference token prefix, e.g. `bb-chat-<chatGuid>`. */
const CHAT_REFERENCE_PREFIX = 'bb-chat-';

/**
 * Deterministic 1:1 chat guid for an iMessage address (BlueBubbles DM format).
 * Doubles as a stable per-recipient barrier key so repeated outbound sends to a
 * brand-new number serialize and don't fork the chat (invariant #4).
 *
 * @param address - The recipient handle (phone/email).
 */
export function dmChatGuid(address: string): string {
  return `iMessage;-;${address}`;
}

/** Read-side context the pure planner needs (all synchronous, no I/O). */
export interface OutboundCtx {
  /** Default service for brand-new conversations. */
  readonly defaultService: Service;
  /** Whether group creation (Private API) is available. */
  readonly privateApi: boolean;
  /** Mint a fresh, stable tempGuid (idempotency key). */
  newTempGuid(): string;
  /** Resolve a known chat by Missive conversation id. */
  getChatGuidByConversation(convId: string): string | null;
  /**
   * Resolve a known chat by the chat guid parsed out of a `bb-chat-<guid>`
   * references token. The worker verifies the guid maps to a known chat (e.g.
   * via `db.getChatByGuid`) and returns the canonical chat guid, or `null` when
   * the reference is stale/unknown (in which case the planner falls through to
   * recipient resolution).
   */
  resolveChatByReference(chatGuid: string): string | null;
  /** Resolve the existing 1:1 chat guid for a single recipient, if any. */
  resolveDmChatGuid(address: string): string | null;
}

/**
 * Extract the chat guid embedded in the first `bb-chat-<guid>` token of a
 * references array. Empty tokens (`bb-chat-`) and non-matching entries are
 * skipped.
 *
 * @param references - The Missive `message.references[]` array (may be absent).
 * @returns The `<guid>` substring, or `null` if no usable token is present.
 */
export function parseChatReference(references: readonly string[] | undefined): string | null {
  if (!references) return null;
  for (const ref of references) {
    if (ref.startsWith(CHAT_REFERENCE_PREFIX)) {
      const guid = ref.slice(CHAT_REFERENCE_PREFIX.length);
      if (guid) return guid;
    }
  }
  return null;
}

/**
 * Plan the single BlueBubbles send for a Missive outbound webhook.
 *
 * @param hook - The verified Missive outbound webhook body.
 * @param ctx - Synchronous resolvers backed by the bridge's database/caps.
 * @returns A {@link SendPlan} describing the resolution + the one send op.
 * @throws {Error} If no recipient/chat target can be resolved, or if a group
 *   conversation must be created but the Private API is unavailable.
 */
export function planOutbound(hook: MissiveOutboundWebhook, ctx: OutboundCtx): SendPlan {
  const { message, conversation } = hook;
  const hasAttachments = (message.attachments?.length ?? 0) > 0;

  /** Build the single message send op for an already-known chat. */
  const messageOp = (chatGuid: string): SendOp =>
    hasAttachments ? { op: 'message/attachment', chatGuid } : { op: 'message/text', chatGuid };

  let result: { resolution: OutboundResolution; send: SendOp } | null = null;

  // (a) chat_map by conversation.id — the strongest binding.
  const byConversation = ctx.getChatGuidByConversation(conversation.id);
  if (byConversation) {
    result = { resolution: 'reply-known-chat', send: messageOp(byConversation) };
  }

  // (b) a bb-chat-<guid> references token that resolves to a known chat.
  if (!result) {
    const parsed = parseChatReference(message.references);
    const resolved = parsed ? ctx.resolveChatByReference(parsed) : null;
    if (resolved) {
      result = { resolution: 'reply-by-reference', send: messageOp(resolved) };
    }
  }

  // (c) recipient resolution: existing 1:1, else a new conversation.
  if (!result) {
    const addresses = (message.to_fields ?? [])
      .map((f) => (f.username && f.username.trim() !== '' ? f.username : f.id))
      .filter((a) => a.length > 0);

    if (addresses.length === 0) {
      throw new Error('planOutbound: no resolvable recipient or chat target');
    }

    const recipient = addresses[0];
    const dm = addresses.length === 1 && recipient ? ctx.resolveDmChatGuid(recipient) : null;

    if (dm) {
      // An existing 1:1 chat — reply into it (no chat/new).
      result = { resolution: 'reply-known-chat', send: messageOp(dm) };
    } else {
      // Brand-new conversation. Groups (multiple recipients) need the Private API.
      if (addresses.length > 1 && !ctx.privateApi) {
        throw new Error(
          'planOutbound: creating a group conversation requires the BlueBubbles Private API',
        );
      }
      result = { resolution: 'new-conversation', send: { op: 'chat/new', addresses } };
    }
  }

  const base: SendPlan = {
    resolution: result.resolution,
    send: result.send,
    tempGuid: ctx.newTempGuid(),
    missiveMsgId: message.id,
  };
  return message.body ? { ...base, text: message.body } : base;
}
