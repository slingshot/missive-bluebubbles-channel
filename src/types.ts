/**
 * Shared type contract for the BlueBubbles <-> Missive bridge.
 *
 * This module is intentionally runtime-free (types/interfaces only) so it is
 * erased at compile time and never appears in coverage. Every other module
 * imports these with `import type`.
 *
 * Sources of truth:
 *  - Missive REST + custom-channel webhook contract.
 *  - BlueBubbles serialized `MessageResponse` + webhook event shapes.
 */

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** Leveled logger verbosity, ordered debug < info < warn < error. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** iMessage delivery service used when creating a brand-new conversation. */
export type Service = 'iMessage' | 'SMS';

/**
 * Fully-validated, frozen runtime configuration. Built once at import from
 * `process.env` (see {@link src/config.ts}); every field is guaranteed present.
 */
export interface Config {
  /** Base URL of the BlueBubbles server (no trailing slash). */
  readonly BB_URL: string;
  /** BlueBubbles server password (sent as `?password=`). */
  readonly BB_PASSWORD: string;
  /** Missive personal access token (Bearer auth). */
  readonly MISSIVE_TOKEN: string;
  /** Missive custom-channel id (the REQUIRED inbound `account`). */
  readonly MISSIVE_ACCOUNT_ID: string;
  /** Shared secret for verifying the Missive outbound webhook HMAC. */
  readonly MISSIVE_HMAC_SECRET: string;
  /** The bridge's own public HTTPS base URL (no trailing slash). */
  readonly PUBLIC_URL: string;
  /** Random token guarding the unsigned BlueBubbles webhook (>= 32 chars). */
  readonly BB_HOOK_TOKEN: string;
  /** The Mac's own iMessage address; used as inbound `to_fields[0]`. */
  readonly SELF_HANDLE: string;
  /** Display name for the bridge's own identity. */
  readonly SELF_NAME: string;
  /** HTTP port to listen on. */
  readonly PORT: number;
  /** Path to the SQLite database (or `:memory:`). */
  readonly DB_PATH: string;
  /** Service used for brand-new outbound conversations. */
  readonly DEFAULT_SERVICE: Service;
  /** If true, download attachments in original encoding (no transcode). */
  readonly ATTACHMENT_ORIGINAL: boolean;
  /** Hard cap (bytes) for a single inbound Missive POST body. */
  readonly MISSIVE_MAX_PAYLOAD_BYTES: number;
  /** If true, surface delivered/read receipts as Missive Posts comments. */
  readonly RECEIPTS_AS_POSTS: boolean;
  /** Interval (ms) for re-probing BlueBubbles Private-API capability. */
  readonly CAPS_REPROBE_MS: number;
  /** Log verbosity. */
  readonly LOG_LEVEL: LogLevel;
}

// ---------------------------------------------------------------------------
// Missive — outbound webhook (Missive -> bridge, agent sends a message)
// ---------------------------------------------------------------------------

/** A Missive participant field (recipient or channel alias). */
export interface MissiveField {
  readonly id: string;
  readonly name?: string;
  readonly username?: string;
}

/** An attachment as delivered on the Missive outbound webhook. */
export interface MissiveOutAttachment {
  readonly id?: string;
  readonly filename?: string;
  readonly media_type?: string;
  readonly sub_type?: string;
  readonly url?: string;
  readonly size?: number;
  /** Some webhooks inline the bytes; otherwise fetch via the REST API. */
  readonly base64_data?: string;
}

/** The `message` object on a Missive outbound webhook. */
export interface MissiveOutMessage {
  readonly id: string;
  readonly type: string;
  readonly body?: string;
  readonly references?: readonly string[];
  readonly from_field?: MissiveField;
  readonly to_fields?: readonly MissiveField[];
  readonly external_id?: string;
  readonly attachments?: readonly MissiveOutAttachment[];
  readonly author?: MissiveField;
}

/** A Missive conversation reference. */
export interface MissiveConversation {
  readonly id: string;
  readonly subject?: string;
}

/** Full Missive outbound webhook body. */
export interface MissiveOutboundWebhook {
  readonly message: MissiveOutMessage;
  readonly conversation: MissiveConversation;
}

// ---------------------------------------------------------------------------
// Missive — inbound message create (bridge -> Missive REST)
// ---------------------------------------------------------------------------

/** Inbound attachment payload — Missive accepts ONLY these two keys. */
export interface MissiveInboundAttachment {
  readonly base64_data: string;
  readonly filename: string;
}

/** The `messages` object posted to `POST /v1/messages`. */
export interface MissiveInboundMessage {
  /** REQUIRED: the custom-channel id. */
  readonly account: string;
  readonly from_field: MissiveField;
  readonly to_fields: readonly MissiveField[];
  readonly body?: string;
  readonly attachments?: readonly MissiveInboundAttachment[];
  /** Chat-level threading keys, e.g. `["bb-chat-<chatGuid>"]`. */
  readonly references: readonly string[];
  /** Per-message idempotency key, e.g. `"bb-msg-<guid>:att1"`. */
  readonly external_id?: string;
  /** Bind to a known conversation when `chat_map` has it. */
  readonly conversation?: string;
  readonly conversation_subject?: string;
  /** Unix seconds. */
  readonly delivered_at?: number;
  /** Unix seconds. */
  readonly created_at?: number;
}

/** Full body for `POST /v1/messages` (wrapped in a `messages` object). */
export interface MissiveInboundBody {
  readonly messages: MissiveInboundMessage;
}

// ---------------------------------------------------------------------------
// BlueBubbles — webhook + serialized message shapes
// ---------------------------------------------------------------------------

/** Generic BlueBubbles webhook envelope: `{ type, data }`. */
export interface BbWebhook {
  readonly type: string;
  readonly data: unknown;
}

/** A handle (the other party) on a BlueBubbles message. */
export interface BbHandle {
  readonly address: string;
  readonly service?: string;
}

/** A chat reference embedded in a serialized BlueBubbles message. */
export interface BbChat {
  readonly guid: string;
  readonly chatIdentifier?: string;
  readonly displayName?: string;
  /** 0 = DM, 1 = group (Apple's chat style). */
  readonly style?: number;
}

/** A serialized BlueBubbles attachment descriptor. */
export interface BbAttachment {
  readonly guid: string;
  readonly mimeType?: string | null;
  readonly transferName?: string | null;
  readonly totalBytes?: number;
  readonly uti?: string | null;
}

/**
 * The serialized BlueBubbles `MessageResponse` carried as `data` on a
 * `new-message` / `updated-message` webhook. Note: `updated-message` events
 * do NOT include `chats[]` (resolve the chat via the `message` table).
 */
export interface BbMessage {
  readonly guid: string;
  readonly text: string | null;
  readonly handle: BbHandle | null;
  readonly isFromMe: boolean;
  readonly chats?: readonly BbChat[];
  readonly attachments?: readonly BbAttachment[];
  readonly associatedMessageGuid?: string | null;
  readonly associatedMessageType?: number | string | null;
  readonly dateCreated?: number;
  readonly dateRead?: number | null;
  readonly dateDelivered?: number | null;
  readonly isDelivered?: boolean;
  readonly dateEdited?: number | null;
  readonly dateRetracted?: number | null;
  readonly partCount?: number;
  readonly groupTitle?: string | null;
  readonly groupActionType?: number | null;
  readonly tempGuid?: string | null;
}

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

/** Detected BlueBubbles Private-API capability snapshot. */
export interface Caps {
  /** True iff `private_api === true && helper_connected === true`. */
  readonly privateApi: boolean;
  /** Raw `helper_connected` flag from the last successful probe. */
  readonly helperConnected: boolean;
  /** Epoch ms of the last successful probe. */
  readonly lastProbeAt: number;
}

// ---------------------------------------------------------------------------
// Durable outbox
// ---------------------------------------------------------------------------

/** The two kinds of durable work the bridge performs. */
export type OutboxKind = 'bb_send' | 'missive_post';

/**
 * Lifecycle state of an outbox row.
 *
 * `claimed` is the lease state a job is flipped to (atomically, in the same
 * transaction that selects it) while a drain pass dispatches it. It keeps a
 * still-in-flight job from being re-claimed by an overlapping pass and keeps the
 * per-chat barrier closed against siblings while the head is in flight; a crash
 * mid-dispatch is recovered on boot via {@link Db.requeueClaimed}.
 */
export type OutboxStatus = 'pending' | 'claimed' | 'done' | 'dead';

/** Input shape for enqueuing a durable job. */
export interface OutboxJob {
  readonly kind: OutboxKind;
  /** Load-bearing for the per-chat barrier; null jobs are never barriered. */
  readonly chat_guid: string | null;
  /** Arbitrary JSON payload (serialized to TEXT). */
  readonly payload: unknown;
  /** Optional scheduled time (epoch ms); defaults to `now()`. */
  readonly next_at?: number;
}

/** A persisted outbox row (claimed for dispatch), with `payload` parsed. */
export interface OutboxRow {
  readonly id: number;
  readonly kind: OutboxKind;
  readonly chat_guid: string | null;
  readonly payload: unknown;
  readonly attempts: number;
  readonly next_at: number;
  readonly status: OutboxStatus;
  readonly last_error: string | null;
  readonly created_at: number;
}

// ---------------------------------------------------------------------------
// Database row types
// ---------------------------------------------------------------------------

/** `chat_map` row — reply routing + Missive threading. */
export interface ChatMap {
  readonly chat_guid: string;
  readonly reference: string;
  readonly conversation_id: string | null;
  readonly subject: string | null;
  readonly created_at: number;
}

/** `handle_map` row — cached display name for an address. */
export interface HandleMap {
  readonly address: string;
  readonly name: string | null;
  readonly updated_at: number;
}

/** `message` row — resolves `guid -> chatGuid` + target text. */
export interface MessageRow {
  readonly bb_guid: string;
  readonly chat_guid: string;
  readonly text: string | null;
  readonly is_from_me: number;
  readonly created_at: number;
}

/** `sent_map` row — outbound idempotency + echo correlation. */
export interface SentMap {
  readonly temp_guid: string;
  readonly chat_guid: string | null;
  readonly missive_msg_id: string | null;
  readonly bb_guid: string | null;
  readonly text: string | null;
  /**
   * Attachment signature for an attachment-carrying send (e.g. `att:2` for a
   * two-file message), or `null` for a plain text send. Lets an inbound
   * attachment echo correlate on chat + recency + attachment count (invariant
   * #5's attachment rule) instead of collapsing onto any null-text row.
   */
  readonly att_sig: string | null;
  readonly echo_consumed: number;
  readonly status: string;
  readonly created_at: number;
}

/** `seen_events` row — dedup ledger. */
export interface SeenEvent {
  readonly id: string;
  readonly created_at: number;
}

// ---------------------------------------------------------------------------
// Domain plan shapes (pure functions emit these; the worker executes them)
// ---------------------------------------------------------------------------

/**
 * One planned inbound Missive post. The pure planner returns the fully-built
 * Missive body plus the guids of any attachments the worker must download and
 * inline as base64 before sending.
 */
export interface InboundPost {
  /** Fully-built Missive body (attachments may still need base64 filled). */
  readonly body: MissiveInboundBody;
  /** BlueBubbles attachment guids to download + inline into `body`. */
  readonly attachmentRefs?: readonly string[];
}

/** How the outbound planner resolved the target BlueBubbles chat. */
export type OutboundResolution = 'reply-known-chat' | 'reply-by-reference' | 'new-conversation';

/** A single BlueBubbles send operation. */
export type SendOp =
  | { readonly op: 'message/text'; readonly chatGuid: string }
  | { readonly op: 'message/attachment'; readonly chatGuid: string }
  | { readonly op: 'chat/new'; readonly addresses: readonly string[] };

/** A planned outbound send (Missive -> BlueBubbles). */
export interface SendPlan {
  readonly resolution: OutboundResolution;
  readonly send: SendOp;
  /** Idempotency key recorded in `sent_map` and reused verbatim on retry. */
  readonly tempGuid: string;
  /** Message text (if any). */
  readonly text?: string;
  /** Correlating Missive message id. */
  readonly missiveMsgId: string;
}
