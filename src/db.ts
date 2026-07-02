/**
 * SQLite persistence layer — the bridge's source of truth.
 *
 * Holds the 6-table schema (mappings, dedup ledger, durable outbox) plus every
 * prepared statement and the load-bearing atomic helpers:
 *  - {@link Db.dedupAndEnqueue} — single-tx "mark seen + enqueue" (invariant #1).
 *  - {@link Db.claimDueJobs}    — per-chat head-of-line barrier (invariant #4 routing).
 *  - {@link Db.consumeEcho}     — single-tx echo consume-on-match (invariant #5).
 *
 * {@link createDb} builds a fully self-contained instance (used directly in
 * tests with `:memory:` for isolation). The module also exposes a process-wide
 * singleton bound to {@link config.DB_PATH}. The clock is overridable via
 * {@link Db.setClock} so timestamps are deterministic under test.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';
import type { ChatMap, HandleMap, OutboxJob, OutboxRow, SentMap } from './types.ts';

/** Public surface of a database instance. */
export interface Db {
  /** The underlying bun:sqlite handle (escape hatch / advanced queries). */
  readonly raw: Database;
  /** Current time in epoch ms (honors {@link Db.setClock}). */
  now(): number;
  /** Override the clock for tests; pass `null` to restore the real clock. */
  setClock(fn: (() => number) | null): void;

  // --- Dedup + durable outbox -------------------------------------------
  /** Atomically mark `seenId` seen and (iff fresh) enqueue `job`. Returns freshness. */
  dedupAndEnqueue(seenId: string, job: OutboxJob): boolean;
  /** Enqueue a durable job unconditionally. */
  enqueue(job: OutboxJob): void;
  /**
   * Atomically lease the dispatchable jobs honoring the per-chat barrier
   * (head-of-line): selects at most one head per chat whose due time has passed
   * and which has no still-active (pending OR claimed) lower-id sibling, then
   * flips each selected row to `claimed` in the SAME transaction. Leasing keeps
   * an overlapping drain pass (or a future second worker) from re-claiming a job
   * already in flight, and keeps the barrier closed against siblings while the
   * head dispatches. Recover orphaned leases on boot with {@link requeueClaimed}.
   */
  claimDueJobs(nowMs: number, limit: number): OutboxRow[];
  /** Reset every `claimed` row back to `pending` (crash recovery on boot). */
  requeueClaimed(): void;
  /** Mark a claimed job done. */
  markDone(id: number): void;
  /** Reschedule a claimed job for a later attempt with the recorded error. */
  reschedule(id: number, attempts: number, nextAt: number, err: string): void;
  /** Dead-letter a claimed job (permanent failure). */
  markDead(id: number, err: string): void;

  // --- Chat mapping -----------------------------------------------------
  /** Upsert a chat<->reference(<->conversation) mapping; returns the row. */
  mapChat(chatGuid: string, reference: string, convId?: string | null): ChatMap;
  /** Look up a chat by its BlueBubbles guid. */
  getChatByGuid(chatGuid: string): ChatMap | null;
  /** Look up a chat by its bound Missive conversation id. */
  getChatByConversation(convId: string): ChatMap | null;
  /** Bind a Missive conversation id onto a known chat. */
  bindConversation(chatGuid: string, convId: string): void;

  // --- Identity cache ---------------------------------------------------
  /** Upsert an address -> display-name mapping. */
  upsertHandle(address: string, name: string | null): void;
  /** Read a cached handle row. */
  getHandle(address: string): HandleMap | null;

  // --- Message cache (resolves guid -> chatGuid / target text) ----------
  /** Cache a seen message so later `updated-message`/tapback events resolve. */
  cacheMessage(bbGuid: string, chatGuid: string, text: string | null, isFromMe: boolean): void;
  /** Resolve the chat guid for a previously-seen message guid. */
  lookupChatForMessage(bbGuid: string): string | null;
  /** Resolve the text for a previously-seen message guid. */
  getMessageText(bbGuid: string): string | null;

  // --- Outbound idempotency + echo correlation --------------------------
  /** Record an outbound send (tempGuid is the retry idempotency key). */
  recordSend(args: {
    tempGuid: string;
    chatGuid: string | null;
    missiveMsgId: string;
    text: string | null;
    /** Attachment signature (e.g. `att:2`) for an attachment send; else null. */
    attSig?: string | null;
  }): void;
  /** Look up a send by the correlating Missive message id. */
  getSendByMissiveId(missiveMsgId: string): SentMap | null;
  /** Record the BlueBubbles guid returned for a send. */
  setSendBbGuid(tempGuid: string, bbGuid: string): void;
  /**
   * Backfill a send's chat guid once a `chat/new` resolves it. The outbound
   * plan records a new-conversation send with a `null` chat_guid (the guid is
   * only known after BlueBubbles creates the chat); writing it back lets the
   * subsequent self-echo — which arrives carrying the real chat guid — match in
   * {@link Db.consumeEcho} (invariant #3 / #5).
   */
  setSendChatGuid(tempGuid: string, chatGuid: string): void;
  /** Find a send whose bb_guid already equals a given guid (exact echo). */
  findEchoByBbGuid(bbGuid: string): SentMap | null;
  /**
   * Echo suppression, consume-on-match (atomic). Returns the matched/consumed
   * `sent_map` row (drop the inbound event) or `null` (genuine inbound).
   */
  consumeEcho(args: {
    chatGuid: string;
    text: string | null;
    /** Attachment signature of the inbound echo; when set, match on it (#5). */
    attSig?: string | null;
    bbGuid?: string | null;
    sinceMs: number;
  }): SentMap | null;
  /** Update a send's status (e.g. `failed`). */
  markSendStatus(tempGuid: string, status: string): void;

  // --- Per-sub-post delivery ledger (invariant #7) ----------------------
  /** Record that a split sub-post's `external_id` was delivered to Missive. */
  markPostDelivered(externalId: string): void;
  /** Whether a sub-post's `external_id` was already delivered (skip on retry). */
  isPostDelivered(externalId: string): boolean;

  // --- Monitoring ---------------------------------------------------------
  /** Tally outbox rows by status, for the monitoring dashboard summary. */
  outboxCounts(): { pending: number; claimed: number; done: number; dead: number };
  /** List the most recently dead-lettered jobs (newest first), payload parsed. */
  listDeadJobs(limit: number): OutboxRow[];
  /** Count inbound messages, outbound sends, and suppressed echoes since a cutoff. */
  activitySince(sinceMs: number): { inbound: number; outbound: number; echoesSuppressed: number };
  /**
   * Revive a dead-lettered job back to `pending` with a fresh attempt budget.
   *
   * Safety: the outbox worker only ever transitions rows it currently holds the
   * lease for (`status = 'claimed'` — see the guards on {@link Db.markDone},
   * {@link Db.reschedule}, {@link Db.markDead}), so a `dead` row is completely
   * inert to the worker until this flips it back to `pending`; there is no race
   * with an in-flight dispatch. The retried row keeps its original (low) `id`,
   * so the per-chat barrier in {@link Db.claimDueJobs} re-serializes it ahead of
   * any newer `pending` siblings for the same chat. Resetting `attempts = 0` is
   * deliberate: it grants the revived job a fresh retry budget rather than
   * resuming where it dead-lettered.
   */
  retryDead(id: number): 'retried' | 'not-dead' | 'missing';

  // --- Maintenance ------------------------------------------------------
  /** Prune dedup ledger, message cache, and done outbox rows older than a cutoff. */
  pruneOld(beforeMs: number): void;
  /** Close the underlying database handle. */
  close(): void;
}

/** Raw outbox row shape as stored (payload is a JSON string). */
interface RawOutboxRow {
  id: number;
  kind: string;
  chat_guid: string | null;
  payload: string;
  attempts: number;
  next_at: number;
  status: string;
  last_error: string | null;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_map (
  chat_guid       TEXT PRIMARY KEY,
  reference       TEXT NOT NULL UNIQUE,
  conversation_id TEXT,
  subject         TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS handle_map (
  address    TEXT PRIMARY KEY,
  name       TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS message (
  bb_guid    TEXT PRIMARY KEY,
  chat_guid  TEXT NOT NULL,
  text       TEXT,
  is_from_me INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sent_map (
  temp_guid      TEXT PRIMARY KEY,
  chat_guid      TEXT,
  missive_msg_id TEXT UNIQUE,
  bb_guid        TEXT,
  text           TEXT,
  att_sig        TEXT,
  echo_consumed  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sent_bb_guid ON sent_map(bb_guid);
CREATE INDEX IF NOT EXISTS idx_sent_chat_created ON sent_map(chat_guid, created_at);

CREATE TABLE IF NOT EXISTS seen_events (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  chat_guid  TEXT,
  payload    TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_status_next ON outbox(status, next_at, id);
CREATE INDEX IF NOT EXISTS idx_outbox_chat_status ON outbox(chat_guid, status, id);
`;

/**
 * Construct a self-contained database instance: open + PRAGMAs + schema +
 * prepared statements + helpers.
 *
 * @param path - File path or `:memory:`.
 * @param initialClock - Optional clock (epoch ms); defaults to {@link Date.now}.
 */
export function createDb(path: string, initialClock?: () => number): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  let clock: () => number = initialClock ?? (() => Date.now());
  const now = (): number => clock();
  const setClock = (fn: (() => number) | null): void => {
    clock = fn ?? (() => Date.now());
  };

  const raw = new Database(path, { strict: true, create: true });
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA busy_timeout = 5000;');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(SCHEMA);

  // --- Prepared statements ----------------------------------------------
  const insSeen = raw.query('INSERT OR IGNORE INTO seen_events (id, created_at) VALUES ($id, $ts)');
  const insOutbox = raw.query(
    `INSERT INTO outbox (kind, chat_guid, payload, attempts, next_at, status, last_error, created_at)
     VALUES ($kind, $chat_guid, $payload, 0, $next_at, 'pending', NULL, $created_at)`,
  );
  const selClaim = raw.query(
    `SELECT * FROM outbox o
     WHERE o.status = 'pending' AND o.next_at <= $now
       AND NOT EXISTS (
         SELECT 1 FROM outbox p
         WHERE p.chat_guid = o.chat_guid
           AND p.status IN ('pending', 'claimed')
           AND p.id < o.id
       )
     ORDER BY o.id
     LIMIT $limit`,
  );
  const updClaim = raw.query("UPDATE outbox SET status = 'claimed' WHERE id = $id");
  const updRequeue = raw.query("UPDATE outbox SET status = 'pending' WHERE status = 'claimed'");
  // State transitions only act on a row this pass currently holds the lease for
  // (`status = 'claimed'`), so a stale write can never resurrect or clobber a
  // row a different transition already settled.
  const updDone = raw.query(
    "UPDATE outbox SET status = 'done' WHERE id = $id AND status = 'claimed'",
  );
  const updReschedule = raw.query(
    `UPDATE outbox SET attempts = $attempts, next_at = $next_at, last_error = $err, status = 'pending'
     WHERE id = $id AND status = 'claimed'`,
  );
  const updDead = raw.query(
    "UPDATE outbox SET status = 'dead', last_error = $err WHERE id = $id AND status = 'claimed'",
  );

  const upsChat = raw.query(
    `INSERT INTO chat_map (chat_guid, reference, conversation_id, subject, created_at)
     VALUES ($chat_guid, $reference, $conversation_id, NULL, $created_at)
     ON CONFLICT(chat_guid) DO UPDATE SET
       reference = excluded.reference,
       conversation_id = COALESCE(excluded.conversation_id, chat_map.conversation_id)`,
  );
  const selChatByGuid = raw.query('SELECT * FROM chat_map WHERE chat_guid = $chat_guid');
  const selChatByConv = raw.query(
    'SELECT * FROM chat_map WHERE conversation_id = $conversation_id',
  );
  const updBindConv = raw.query(
    'UPDATE chat_map SET conversation_id = $conversation_id WHERE chat_guid = $chat_guid',
  );

  const upsHandle = raw.query(
    `INSERT INTO handle_map (address, name, updated_at) VALUES ($address, $name, $updated_at)
     ON CONFLICT(address) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
  );
  const selHandle = raw.query('SELECT * FROM handle_map WHERE address = $address');

  const upsMessage = raw.query(
    `INSERT INTO message (bb_guid, chat_guid, text, is_from_me, created_at)
     VALUES ($bb_guid, $chat_guid, $text, $is_from_me, $created_at)
     ON CONFLICT(bb_guid) DO UPDATE SET
       chat_guid = excluded.chat_guid, text = excluded.text, is_from_me = excluded.is_from_me`,
  );
  const selMsgChat = raw.query('SELECT chat_guid FROM message WHERE bb_guid = $bb_guid');
  const selMsgText = raw.query('SELECT text FROM message WHERE bb_guid = $bb_guid');

  const insSent = raw.query(
    `INSERT INTO sent_map (temp_guid, chat_guid, missive_msg_id, bb_guid, text, att_sig, echo_consumed, status, created_at)
     VALUES ($temp_guid, $chat_guid, $missive_msg_id, NULL, $text, $att_sig, 0, 'pending', $created_at)`,
  );
  const selSentByMissive = raw.query(
    'SELECT * FROM sent_map WHERE missive_msg_id = $missive_msg_id',
  );
  const updSentBbGuid = raw.query(
    'UPDATE sent_map SET bb_guid = $bb_guid WHERE temp_guid = $temp_guid',
  );
  const updSentChatGuid = raw.query(
    'UPDATE sent_map SET chat_guid = $chat_guid WHERE temp_guid = $temp_guid',
  );
  const selSentByBbGuid = raw.query('SELECT * FROM sent_map WHERE bb_guid = $bb_guid LIMIT 1');
  const updSentStatus = raw.query(
    'UPDATE sent_map SET status = $status WHERE temp_guid = $temp_guid',
  );
  // Text echo: correlate a plain (non-attachment) send by chat + exact text.
  // `att_sig IS NULL` keeps a text echo from consuming an attachment send's row.
  const selEchoText = raw.query(
    `SELECT * FROM sent_map
     WHERE chat_guid = $chat_guid
       AND echo_consumed = 0
       AND att_sig IS NULL
       AND ( ($text IS NULL AND text IS NULL) OR text = $text )
       AND created_at >= $since
     ORDER BY created_at ASC, temp_guid ASC
     LIMIT 1`,
  );
  // Attachment echo: correlate by chat + recency + attachment signature (count),
  // so an attachment echo never collapses onto a sibling null-text text send
  // and a 2-file send is distinguished from a 1-file send (invariant #5).
  const selEchoAtt = raw.query(
    `SELECT * FROM sent_map
     WHERE chat_guid = $chat_guid
       AND echo_consumed = 0
       AND att_sig = $att_sig
       AND created_at >= $since
     ORDER BY created_at ASC, temp_guid ASC
     LIMIT 1`,
  );
  const updEchoConsumed = raw.query(
    'UPDATE sent_map SET echo_consumed = 1, bb_guid = COALESCE(bb_guid, $bb_guid) WHERE temp_guid = $temp_guid',
  );

  const selSeen = raw.query('SELECT 1 AS hit FROM seen_events WHERE id = $id');

  const selOutboxCounts = raw.query('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status');
  const selDeadJobs = raw.query(
    "SELECT * FROM outbox WHERE status = 'dead' ORDER BY id DESC LIMIT $limit",
  );
  const selInboundSince = raw.query(
    'SELECT COUNT(*) AS n FROM message WHERE is_from_me = 0 AND created_at >= $since',
  );
  const selOutboundSince = raw.query(
    'SELECT COUNT(*) AS n FROM sent_map WHERE created_at >= $since',
  );
  const selEchoesSuppressedSince = raw.query(
    'SELECT COUNT(*) AS n FROM sent_map WHERE echo_consumed = 1 AND created_at >= $since',
  );
  const selOutboxStatus = raw.query('SELECT status FROM outbox WHERE id = $id');
  const updRetryDead = raw.query(
    `UPDATE outbox SET status = 'pending', attempts = 0, next_at = $next_at, last_error = NULL
     WHERE id = $id AND status = 'dead'`,
  );

  const delSeen = raw.query('DELETE FROM seen_events WHERE created_at < $before');
  const delMsg = raw.query('DELETE FROM message WHERE created_at < $before');
  const delOutbox = raw.query("DELETE FROM outbox WHERE status = 'done' AND created_at < $before");

  // --- Internal helpers -------------------------------------------------
  const insertOutbox = (job: OutboxJob): void => {
    insOutbox.run({
      kind: job.kind,
      chat_guid: job.chat_guid,
      payload: JSON.stringify(job.payload ?? null),
      next_at: job.next_at ?? now(),
      created_at: now(),
    });
  };

  const toOutboxRow = (r: RawOutboxRow): OutboxRow => ({
    id: Number(r.id),
    kind: r.kind as OutboxRow['kind'],
    chat_guid: r.chat_guid,
    payload: JSON.parse(r.payload),
    attempts: r.attempts,
    next_at: r.next_at,
    status: r.status as OutboxRow['status'],
    last_error: r.last_error,
    created_at: r.created_at,
  });

  // --- Atomic transactions ----------------------------------------------
  const dedupAndEnqueue = raw.transaction((seenId: string, job: OutboxJob): boolean => {
    const fresh = insSeen.run({ id: seenId, ts: now() }).changes === 1;
    if (fresh) insertOutbox(job);
    return fresh;
  });

  const consumeEcho = raw.transaction(
    (args: {
      chatGuid: string;
      text: string | null;
      attSig?: string | null;
      bbGuid?: string | null;
      sinceMs: number;
    }): SentMap | null => {
      // (a) exact bb_guid correlation -> definitely our echo.
      if (args.bbGuid != null) {
        const exact = selSentByBbGuid.get({ bb_guid: args.bbGuid }) as SentMap | undefined;
        if (exact) return exact;
      }
      // (b) oldest unconsumed row matching chat + recency, keyed on the
      //     attachment signature when the echo carries attachments, else on text.
      const row = (
        args.attSig != null
          ? selEchoAtt.get({ chat_guid: args.chatGuid, att_sig: args.attSig, since: args.sinceMs })
          : selEchoText.get({ chat_guid: args.chatGuid, text: args.text, since: args.sinceMs })
      ) as SentMap | undefined;
      if (!row) return null;
      updEchoConsumed.run({ temp_guid: row.temp_guid, bb_guid: args.bbGuid ?? null });
      return { ...row, echo_consumed: 1, bb_guid: row.bb_guid ?? args.bbGuid ?? null };
    },
  );

  // Lease in one transaction: select the barrier-eligible heads, then flip each
  // to `claimed` so a concurrent/overlapping pass cannot re-select them.
  const claimDueJobs = raw.transaction((nowMs: number, limit: number): OutboxRow[] => {
    const rows = selClaim.all({ now: nowMs, limit }) as RawOutboxRow[];
    for (const r of rows) updClaim.run({ id: r.id });
    return rows.map((r) => toOutboxRow({ ...r, status: 'claimed' }));
  });

  const retryDead = raw.transaction((id: number): 'retried' | 'not-dead' | 'missing' => {
    const row = selOutboxStatus.get({ id }) as { status: string } | undefined;
    if (!row) return 'missing';
    if (row.status !== 'dead') return 'not-dead';
    updRetryDead.run({ id, next_at: now() });
    return 'retried';
  });

  const pruneOld = raw.transaction((beforeMs: number): void => {
    delSeen.run({ before: beforeMs });
    delMsg.run({ before: beforeMs });
    delOutbox.run({ before: beforeMs });
  });

  return {
    raw,
    now,
    setClock,
    dedupAndEnqueue,
    enqueue: (job) => insertOutbox(job),
    claimDueJobs: (nowMs, limit) => claimDueJobs(nowMs, limit),
    requeueClaimed: () => {
      updRequeue.run();
    },
    markDone: (id) => {
      updDone.run({ id });
    },
    reschedule: (id, attempts, nextAt, err) => {
      updReschedule.run({ id, attempts, next_at: nextAt, err });
    },
    markDead: (id, err) => {
      updDead.run({ id, err });
    },
    mapChat: (chatGuid, reference, convId) => {
      upsChat.run({
        chat_guid: chatGuid,
        reference,
        conversation_id: convId ?? null,
        created_at: now(),
      });
      return selChatByGuid.get({ chat_guid: chatGuid }) as ChatMap;
    },
    getChatByGuid: (chatGuid) =>
      (selChatByGuid.get({ chat_guid: chatGuid }) as ChatMap | undefined) ?? null,
    getChatByConversation: (convId) =>
      (selChatByConv.get({ conversation_id: convId }) as ChatMap | undefined) ?? null,
    bindConversation: (chatGuid, convId) => {
      updBindConv.run({ chat_guid: chatGuid, conversation_id: convId });
    },
    upsertHandle: (address, name) => {
      upsHandle.run({ address, name, updated_at: now() });
    },
    getHandle: (address) => (selHandle.get({ address }) as HandleMap | undefined) ?? null,
    cacheMessage: (bbGuid, chatGuid, text, isFromMe) => {
      upsMessage.run({
        bb_guid: bbGuid,
        chat_guid: chatGuid,
        text,
        is_from_me: isFromMe ? 1 : 0,
        created_at: now(),
      });
    },
    lookupChatForMessage: (bbGuid) => {
      const row = selMsgChat.get({ bb_guid: bbGuid }) as { chat_guid: string } | undefined;
      return row?.chat_guid ?? null;
    },
    getMessageText: (bbGuid) => {
      const row = selMsgText.get({ bb_guid: bbGuid }) as { text: string | null } | undefined;
      return row?.text ?? null;
    },
    recordSend: (a) => {
      insSent.run({
        temp_guid: a.tempGuid,
        chat_guid: a.chatGuid,
        missive_msg_id: a.missiveMsgId,
        text: a.text,
        att_sig: a.attSig ?? null,
        created_at: now(),
      });
    },
    getSendByMissiveId: (missiveMsgId) =>
      (selSentByMissive.get({ missive_msg_id: missiveMsgId }) as SentMap | undefined) ?? null,
    setSendBbGuid: (tempGuid, bbGuid) => {
      updSentBbGuid.run({ temp_guid: tempGuid, bb_guid: bbGuid });
    },
    setSendChatGuid: (tempGuid, chatGuid) => {
      updSentChatGuid.run({ temp_guid: tempGuid, chat_guid: chatGuid });
    },
    findEchoByBbGuid: (bbGuid) =>
      (selSentByBbGuid.get({ bb_guid: bbGuid }) as SentMap | undefined) ?? null,
    consumeEcho,
    markSendStatus: (tempGuid, status) => {
      updSentStatus.run({ temp_guid: tempGuid, status });
    },
    markPostDelivered: (externalId) => {
      insSeen.run({ id: `post:${externalId}`, ts: now() });
    },
    isPostDelivered: (externalId) => selSeen.get({ id: `post:${externalId}` }) != null,
    outboxCounts: () => {
      const counts = { pending: 0, claimed: 0, done: 0, dead: 0 };
      for (const r of selOutboxCounts.all() as { status: string; n: number }[]) {
        counts[r.status as keyof typeof counts] = r.n;
      }
      return counts;
    },
    listDeadJobs: (limit) => (selDeadJobs.all({ limit }) as RawOutboxRow[]).map(toOutboxRow),
    activitySince: (sinceMs) => ({
      inbound: (selInboundSince.get({ since: sinceMs }) as { n: number }).n,
      outbound: (selOutboundSince.get({ since: sinceMs }) as { n: number }).n,
      echoesSuppressed: (selEchoesSuppressedSince.get({ since: sinceMs }) as { n: number }).n,
    }),
    retryDead,
    pruneOld,
    close: () => raw.close(),
  };
}

/** The process-wide database singleton, bound to {@link config.DB_PATH}. */
export const db: Db = createDb(config.DB_PATH);

/** Current time in epoch ms (honors {@link setClock}); singleton clock. */
export const now = db.now;
/** Override the singleton clock for tests; `null` restores the real clock. */
export const setClock = db.setClock;
