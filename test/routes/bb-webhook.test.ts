/**
 * Tests for the BlueBubbles webhook route.
 *
 * Covers the constant-time token guard (same-length + different-length
 * mismatches), the body-size cap, JSON guard, per-class dedup keying with the
 * resolved `chat_guid` (new-message via `chats[]`, updated-message via the
 * message cache, group events via `chatGuid`, guid-less events), and the
 * ephemeral typing/read-status drop with its in-memory throttle.
 */

import { describe, expect, it } from 'bun:test';
import { createDb, type Db } from '../../src/db.ts';
import type { Logger } from '../../src/logger.ts';
import { bbWebhookRoute, evictStaleEphemeral } from '../../src/routes/bb-webhook.ts';
import type { OutboxRow } from '../../src/types.ts';

const TOKEN = 'bb-hook-token-0123456789abcdef-0123';

/** A logger that records every emitted line for assertions. */
function makeLogger(): Logger & { calls: { level: string; msg: string }[] } {
  const calls: { level: string; msg: string }[] = [];
  const at =
    (level: string) =>
    (msg: string): void => {
      calls.push({ level, msg });
    };
  return { calls, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** Build a fresh in-memory DB (mutable clock) + route under test. */
function harness(
  start = 1_000_000,
  opts: { receiptsAsPosts?: boolean } = {},
): {
  db: Db;
  logger: ReturnType<typeof makeLogger>;
  setNow: (ms: number) => void;
  handle: (token: string, body: string) => Promise<Response>;
} {
  let nowMs = start;
  const db = createDb(':memory:', () => nowMs);
  const logger = makeLogger();
  const app = bbWebhookRoute({
    db,
    logger,
    hookToken: TOKEN,
    ...(opts.receiptsAsPosts !== undefined ? { receiptsAsPosts: opts.receiptsAsPosts } : {}),
  });
  return {
    db,
    logger,
    setNow: (ms) => {
      nowMs = ms;
    },
    handle: (token, body) =>
      app.handle(new Request(`http://localhost/bb/webhook/${token}`, { method: 'POST', body })),
  };
}

/** Read every enqueued outbox row. */
function jobs(db: Db): OutboxRow[] {
  return db.claimDueJobs(db.now(), 100);
}

/** Count emitted debug lines with a given message. */
function debugCount(logger: ReturnType<typeof makeLogger>, msg: string): number {
  return logger.calls.filter((c) => c.level === 'debug' && c.msg === msg).length;
}

describe('bbWebhookRoute', () => {
  it('accepts a new-message event and enqueues with chat_guid from chats[]', async () => {
    const { db, logger, handle } = harness();
    const evt = {
      type: 'new-message',
      data: { guid: 'm-1', text: 'hello', chats: [{ guid: 'chat-A' }] },
    };
    const res = await handle(TOKEN, JSON.stringify(evt));

    expect(res.status).toBe(200);
    const enqueued = jobs(db);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.kind).toBe('missive_post');
    expect(enqueued[0]?.chat_guid).toBe('chat-A');
    const seen = db.raw.query('SELECT id FROM seen_events').all() as { id: string }[];
    expect(seen).toEqual([{ id: 'bb:new-message:m-1' }]);
    expect(logger.calls).toContainEqual({ level: 'info', msg: 'bb webhook accepted' });
  });

  it('deduplicates a repeated new-message event', async () => {
    const { db, handle } = harness();
    const evt = JSON.stringify({
      type: 'new-message',
      data: { guid: 'm-dup', chats: [{ guid: 'c' }] },
    });
    await handle(TOKEN, evt);
    await handle(TOKEN, evt);
    expect(jobs(db)).toHaveLength(1);
  });

  it('resolves chat_guid for an updated-message via the message cache', async () => {
    const { db, handle } = harness();
    db.cacheMessage('m-up', 'chat-cached', 'orig', false);
    const evt = {
      type: 'updated-message',
      data: { guid: 'm-up', dateEdited: 5, isDelivered: true },
    };
    const res = await handle(TOKEN, JSON.stringify(evt));

    expect(res.status).toBe(200);
    const enqueued = jobs(db);
    expect(enqueued[0]?.chat_guid).toBe('chat-cached');
    const seen = db.raw.query('SELECT id FROM seen_events').all() as { id: string }[];
    expect(seen[0]?.id).toBe('bb:updated:m-up:1:0:5:0');
  });

  it('resolves chat_guid for a group event via data.chatGuid', async () => {
    const { db, handle } = harness();
    const evt = { type: 'group-name-change', data: { chatGuid: 'chat-grp', newName: 'Team' } };
    const res = await handle(TOKEN, JSON.stringify(evt));

    expect(res.status).toBe(200);
    expect(jobs(db)[0]?.chat_guid).toBe('chat-grp');
  });

  it('enqueues a guid-less event with a null chat_guid and hashed key', async () => {
    const { db, handle } = harness();
    const evt = { type: 'message-send-error', data: { error: 22, code: 'x' } };
    const res = await handle(TOKEN, JSON.stringify(evt));

    expect(res.status).toBe(200);
    const enqueued = jobs(db);
    expect(enqueued[0]?.chat_guid).toBeNull();
    const seen = db.raw.query('SELECT id FROM seen_events').all() as { id: string }[];
    expect(seen[0]?.id.startsWith('bb:message-send-error:')).toBe(true);
  });

  it('falls back to a null chat_guid when an updated-message is uncached', async () => {
    const { db, handle } = harness();
    const evt = { type: 'updated-message', data: { guid: 'never-seen', dateRead: 9 } };
    const res = await handle(TOKEN, JSON.stringify(evt));

    expect(res.status).toBe(200);
    expect(jobs(db)[0]?.chat_guid).toBeNull();
  });

  it('rejects a same-length wrong token with 404 and never enqueues', async () => {
    const { db, logger, handle } = harness();
    const wrong = `${TOKEN.slice(0, -1)}X`;
    expect(wrong.length).toBe(TOKEN.length);
    const res = await handle(wrong, JSON.stringify({ type: 'new-message', data: { guid: 'g' } }));

    expect(res.status).toBe(404);
    expect(jobs(db)).toHaveLength(0);
    expect(logger.calls).toContainEqual({ level: 'warn', msg: 'bb webhook rejected: bad token' });
  });

  it('rejects a different-length token with 404', async () => {
    const { db, handle } = harness();
    const res = await handle('short', JSON.stringify({ type: 'new-message', data: { guid: 'g' } }));
    expect(res.status).toBe(404);
    expect(jobs(db)).toHaveLength(0);
  });

  it('rejects an oversized body with 413', async () => {
    const { db, logger, handle } = harness();
    const huge = 'a'.repeat(2_000_001);
    const res = await handle(TOKEN, huge);

    expect(res.status).toBe(413);
    expect(jobs(db)).toHaveLength(0);
    expect(logger.calls).toContainEqual({
      level: 'warn',
      msg: 'bb webhook rejected: body too large',
    });
  });

  it('rejects an unparseable body with 400', async () => {
    const { db, logger, handle } = harness();
    const res = await handle(TOKEN, 'not-json{');
    expect(res.status).toBe(400);
    expect(jobs(db)).toHaveLength(0);
    expect(logger.calls).toContainEqual({
      level: 'warn',
      msg: 'bb webhook rejected: invalid json',
    });
  });

  it('drops typing-indicator events without enqueuing, throttling repeats', async () => {
    const { db, logger, setNow, handle } = harness(1_000_000);
    const typing = JSON.stringify({
      type: 'typing-indicator',
      data: { display: true, guid: 'c1' },
    });

    expect((await handle(TOKEN, typing)).status).toBe(200);
    expect((await handle(TOKEN, typing)).status).toBe(200); // throttled (same instant)
    expect(debugCount(logger, 'bb ephemeral event dropped')).toBe(1);

    // Advance past the throttle window -> logs again.
    setNow(1_000_000 + 11_000);
    expect((await handle(TOKEN, typing)).status).toBe(200);
    expect(debugCount(logger, 'bb ephemeral event dropped')).toBe(2);

    // Never enqueued, never persisted.
    expect(jobs(db)).toHaveLength(0);
    expect(db.raw.query('SELECT COUNT(*) AS n FROM seen_events').get()).toEqual({ n: 0 });
  });

  it('drops chat-read-status-changed events without enqueuing', async () => {
    const { db, handle } = harness();
    const evt = JSON.stringify({
      type: 'chat-read-status-changed',
      data: { chatGuid: 'c1', read: true },
    });
    const res = await handle(TOKEN, evt);
    expect(res.status).toBe(200);
    expect(jobs(db)).toHaveLength(0);
  });

  it('enqueues a read-status as a Posts job when RECEIPTS_AS_POSTS is on (throttled)', async () => {
    const { db, logger, setNow, handle } = harness(1_000_000, { receiptsAsPosts: true });
    const evt = JSON.stringify({
      type: 'chat-read-status-changed',
      data: { chatGuid: 'c-read', read: true },
    });
    const enqueuedRows = () =>
      db.raw
        .query("SELECT kind, chat_guid FROM outbox WHERE status = 'pending' ORDER BY id")
        .all() as {
        kind: string;
        chat_guid: string | null;
      }[];

    expect((await handle(TOKEN, evt)).status).toBe(200);
    expect((await handle(TOKEN, evt)).status).toBe(200); // throttled (same instant)
    let rows = enqueuedRows();
    expect(rows).toHaveLength(1); // throttle collapsed the duplicate
    expect(rows[0]).toEqual({ kind: 'missive_post', chat_guid: 'c-read' });
    expect(debugCount(logger, 'bb read receipt enqueued as post')).toBe(1);
    // Ephemeral -> never persistently deduped.
    expect(db.raw.query('SELECT COUNT(*) AS n FROM seen_events').get()).toEqual({ n: 0 });

    // Past the throttle window -> a second post is enqueued (no persistent dedup).
    setNow(1_000_000 + 11_000);
    expect((await handle(TOKEN, evt)).status).toBe(200);
    rows = enqueuedRows();
    expect(rows).toHaveLength(2);
    expect(debugCount(logger, 'bb read receipt enqueued as post')).toBe(2);
  });

  it('still drops typing-indicator even with RECEIPTS_AS_POSTS on', async () => {
    const { db, logger, handle } = harness(1_000_000, { receiptsAsPosts: true });
    const evt = JSON.stringify({ type: 'typing-indicator', data: { display: true, guid: 'c1' } });
    expect((await handle(TOKEN, evt)).status).toBe(200);
    expect(jobs(db)).toHaveLength(0);
    expect(debugCount(logger, 'bb ephemeral event dropped')).toBe(1);
  });
});

describe('evictStaleEphemeral', () => {
  it('drops entries older than the throttle window and keeps fresh ones', () => {
    const now = 1_000_000;
    const map = new Map<string, number>([
      ['stale', now - 10_000], // exactly at the window -> evicted
      ['older', now - 60_000], // well past -> evicted
      ['fresh', now - 1_000], // within the window -> kept
    ]);
    evictStaleEphemeral(map, now);
    expect([...map.keys()]).toEqual(['fresh']);
  });
});
