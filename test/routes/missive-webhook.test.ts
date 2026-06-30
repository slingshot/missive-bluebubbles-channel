/**
 * Tests for the Missive outbound webhook route.
 *
 * Exercises the raw-body HMAC gate (invariant #1: 401 before parse, never
 * re-serialize), the atomic dedup+enqueue, and the JSON / message-id guards —
 * all via `app.handle()` (no port binding).
 */

import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import { createDb, type Db } from '../../src/db.ts';
import type { Logger } from '../../src/logger.ts';
import { missiveWebhookRoute } from '../../src/routes/missive-webhook.ts';
import type { OutboxRow } from '../../src/types.ts';

const SECRET = 'missive-signing-secret';

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

/** Compute a valid `X-Hook-Signature` for a raw body. */
function sign(secret: string, raw: string): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

/** Build a fresh in-memory DB + route under test. */
function harness(): {
  db: Db;
  logger: ReturnType<typeof makeLogger>;
  handle: (req: Request) => Promise<Response>;
} {
  const db = createDb(':memory:', () => 1_000_000);
  const logger = makeLogger();
  const app = missiveWebhookRoute({ db, logger, hmacSecret: SECRET });
  return { db, logger, handle: (req) => app.handle(req) };
}

/** Build a `POST /missive/webhook` request with the given raw body + headers. */
function post(raw: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/missive/webhook', { method: 'POST', body: raw, headers });
}

/** Read every enqueued outbox row (claim with a generous window). */
function jobs(db: Db): OutboxRow[] {
  return db.claimDueJobs(db.now(), 100);
}

describe('missiveWebhookRoute', () => {
  it('accepts a valid signed webhook and enqueues a bb_send job', async () => {
    const { db, logger, handle } = harness();
    const body = JSON.stringify({
      message: { id: 'msg-1', type: 'custom_text', body: 'hi' },
      conversation: { id: 'conv-1' },
    });
    const res = await handle(post(body, { 'X-Hook-Signature': sign(SECRET, body) }));

    expect(res.status).toBe(200);
    const enqueued = jobs(db);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.kind).toBe('bb_send');
    expect(enqueued[0]?.chat_guid).toBeNull();
    expect((enqueued[0]?.payload as { message: { id: string } }).message.id).toBe('msg-1');
    // seen ledger records the per-message dedup key.
    const seen = db.raw.query('SELECT id FROM seen_events').all() as { id: string }[];
    expect(seen).toEqual([{ id: 'missive:msg-1' }]);
    expect(logger.calls).toContainEqual({ level: 'info', msg: 'missive webhook accepted' });
  });

  it('deduplicates a repeated message id (enqueues once)', async () => {
    const { db, handle } = harness();
    const body = JSON.stringify({ message: { id: 'dup' }, conversation: { id: 'c' } });
    const headers = { 'X-Hook-Signature': sign(SECRET, body) };

    const first = await handle(post(body, headers));
    const second = await handle(post(body, headers));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(jobs(db)).toHaveLength(1);
  });

  it('rejects a tampered signature with 401 and never enqueues', async () => {
    const { db, logger, handle } = harness();
    const body = JSON.stringify({ message: { id: 'x' }, conversation: { id: 'c' } });
    // Sign different bytes -> mismatch.
    const res = await handle(post(body, { 'X-Hook-Signature': sign(SECRET, `${body}tamper`) }));

    expect(res.status).toBe(401);
    expect(jobs(db)).toHaveLength(0);
    expect(logger.calls).toContainEqual({
      level: 'warn',
      msg: 'missive webhook rejected: bad signature',
    });
  });

  it('rejects a missing signature header with 401', async () => {
    const { db, handle } = harness();
    const body = JSON.stringify({ message: { id: 'x' }, conversation: { id: 'c' } });
    const res = await handle(post(body));
    expect(res.status).toBe(401);
    expect(jobs(db)).toHaveLength(0);
  });

  it('rejects a signed but unparseable body with 400', async () => {
    const { db, logger, handle } = harness();
    const body = 'not-json{';
    const res = await handle(post(body, { 'X-Hook-Signature': sign(SECRET, body) }));

    expect(res.status).toBe(400);
    expect(jobs(db)).toHaveLength(0);
    expect(logger.calls).toContainEqual({
      level: 'warn',
      msg: 'missive webhook rejected: invalid json',
    });
  });

  it('rejects a signed body with no message id with 400', async () => {
    const { db, logger, handle } = harness();
    const body = JSON.stringify({ conversation: { id: 'c' } });
    const res = await handle(post(body, { 'X-Hook-Signature': sign(SECRET, body) }));

    expect(res.status).toBe(400);
    expect(jobs(db)).toHaveLength(0);
    expect(logger.calls).toContainEqual({
      level: 'warn',
      msg: 'missive webhook rejected: missing message id',
    });
  });
});

describe('missiveWebhookRoute — barrier chat_guid resolution (#4)', () => {
  /** Post a signed webhook and read back the single enqueued bb_send job. */
  async function enqueue(db: Db, handle: (req: Request) => Promise<Response>, hook: unknown) {
    const body = JSON.stringify(hook);
    const res = await handle(post(body, { 'X-Hook-Signature': sign(SECRET, body) }));
    expect(res.status).toBe(200);
    return jobs(db)[0];
  }

  it('keys on a chat already bound to the conversation', async () => {
    const { db, handle } = harness();
    db.mapChat('CHAT-CONV', 'bb-chat-CHAT-CONV', 'conv-7');
    const job = await enqueue(db, handle, {
      message: { id: 'b1', type: 'custom_text', body: 'hi', references: [] },
      conversation: { id: 'conv-7' },
    });
    expect(job?.chat_guid).toBe('CHAT-CONV');
  });

  it('keys on a bb-chat-<guid> references token that resolves to a known chat', async () => {
    const { db, handle } = harness();
    db.mapChat('CHAT-REF', 'bb-chat-CHAT-REF');
    const job = await enqueue(db, handle, {
      message: { id: 'b2', type: 'custom_text', body: 'hi', references: ['bb-chat-CHAT-REF'] },
      conversation: { id: 'conv-unbound' },
    });
    expect(job?.chat_guid).toBe('CHAT-REF');
  });

  it('keys a fresh single-recipient send on the deterministic DM guid', async () => {
    const { db, handle } = harness();
    const job = await enqueue(db, handle, {
      message: {
        id: 'b3',
        type: 'custom_text',
        body: 'first contact',
        to_fields: [{ id: 'pid', username: '+15551239999' }],
        references: [],
      },
      conversation: { id: 'conv-new' },
    });
    // Serializes repeat first-contact sends to the same number (no fork).
    expect(job?.chat_guid).toBe('iMessage;-;+15551239999');
  });

  it('falls back to the id when a single recipient has no username', async () => {
    const { db, handle } = harness();
    const job = await enqueue(db, handle, {
      message: {
        id: 'b4',
        type: 'custom_text',
        body: 'x',
        to_fields: [{ id: '+15550000000' }],
        references: [],
      },
      conversation: { id: 'conv-new2' },
    });
    expect(job?.chat_guid).toBe('iMessage;-;+15550000000');
  });

  it('keys null when a lone recipient has no resolvable address', async () => {
    const { db, handle } = harness();
    const job = await enqueue(db, handle, {
      message: {
        id: 'b5',
        type: 'custom_text',
        body: 'x',
        to_fields: [{ id: '', username: '' }],
        references: [],
      },
      conversation: { id: 'conv-empty' },
    });
    expect(job?.chat_guid).toBeNull();
  });
});
