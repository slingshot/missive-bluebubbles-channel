import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, type Db, db, now, setClock } from '../src/db.ts';
import type { OutboxJob } from '../src/types.ts';

/** A test DB with a mutable, deterministic clock. */
function freshDb(start = 1_000_000): { d: Db; at: (t: number) => void } {
  let t = start;
  const d = createDb(':memory:', () => t);
  return {
    d,
    at: (next) => {
      t = next;
    },
  };
}

const bbJob = (chatGuid: string | null, payload: unknown = { n: 1 }): OutboxJob => ({
  kind: 'bb_send',
  chat_guid: chatGuid,
  payload,
});

describe('createDb — clock + lifecycle', () => {
  it('defaults to the real clock when none is injected', () => {
    const d = createDb(':memory:');
    const before = Date.now();
    const t = d.now();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now() + 50);
    d.close();
  });

  it('honors an injected clock and setClock override/reset', () => {
    const d = createDb(':memory:', () => 42);
    expect(d.now()).toBe(42);
    d.setClock(() => 99);
    expect(d.now()).toBe(99);
    d.setClock(null);
    expect(d.now()).toBeGreaterThan(1_000);
    d.close();
  });

  it('creates parent directories for a file-backed database', () => {
    const root = join(tmpdir(), `bridge-db-${crypto.randomUUID()}`);
    const path = join(root, 'nested', 'deep', 'bridge.sqlite');
    const d = createDb(path);
    d.upsertHandle('+1', 'A');
    expect(d.getHandle('+1')?.name).toBe('A');
    d.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('throws once closed', () => {
    const d = createDb(':memory:');
    d.close();
    expect(() => d.getHandle('x')).toThrow();
  });
});

describe('dedupAndEnqueue (atomic) + outbox basics', () => {
  it('enqueues exactly once for a fresh id and never again', () => {
    const { d } = freshDb();
    expect(d.dedupAndEnqueue('missive:1', bbJob(null))).toBe(true);
    expect(d.dedupAndEnqueue('missive:1', bbJob(null))).toBe(false);
    // Only the first call inserted an outbox row.
    expect(d.claimDueJobs(d.now(), 10)).toHaveLength(1);
  });

  it('enqueue() inserts unconditionally and parses payload back out', () => {
    const { d } = freshDb();
    d.enqueue(bbJob('C', { hello: 'world' }));
    const [row] = d.claimDueJobs(d.now(), 10);
    expect(row?.kind).toBe('bb_send');
    expect(row?.chat_guid).toBe('C');
    expect(row?.payload).toEqual({ hello: 'world' });
    expect(row?.attempts).toBe(0);
    // claimDueJobs leases the row, so it comes back already flipped to 'claimed'.
    expect(row?.status).toBe('claimed');
    expect(row?.last_error).toBeNull();
    expect(typeof row?.id).toBe('number');
    expect(typeof row?.created_at).toBe('number');
  });

  it('stores a null payload when none is provided', () => {
    const { d } = freshDb();
    d.enqueue({ kind: 'missive_post', chat_guid: null, payload: undefined });
    expect(d.claimDueJobs(d.now(), 10)[0]?.payload).toBeNull();
  });

  it('respects an explicit future next_at', () => {
    const { d } = freshDb();
    d.enqueue({ kind: 'bb_send', chat_guid: 'C', payload: {}, next_at: d.now() + 1_000 });
    expect(d.claimDueJobs(d.now(), 10)).toHaveLength(0);
    expect(d.claimDueJobs(d.now() + 1_000, 10)).toHaveLength(1);
  });
});

describe('claimDueJobs — per-chat barrier', () => {
  it('returns only the head-of-line job per chat', () => {
    const { d } = freshDb();
    d.enqueue(bbJob('A')); // id 1
    d.enqueue(bbJob('A')); // id 2 (barriered)
    const first = d.claimDueJobs(d.now(), 10);
    expect(first).toHaveLength(1);
    d.markDone(first[0]!.id);
    const second = d.claimDueJobs(d.now(), 10);
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id + 1);
  });

  it('never barriers NULL-chat jobs against each other', () => {
    const { d } = freshDb();
    d.enqueue(bbJob(null));
    d.enqueue(bbJob(null));
    expect(d.claimDueJobs(d.now(), 10)).toHaveLength(2);
  });

  it('runs different chats concurrently (one head per chat)', () => {
    const { d } = freshDb();
    d.enqueue(bbJob('A')); // id1 head A
    d.enqueue(bbJob('A')); // id2 barriered
    d.enqueue(bbJob('B')); // id3 head B
    const claimed = d.claimDueJobs(d.now(), 10);
    expect(claimed.map((r) => r.chat_guid).sort()).toEqual(['A', 'B']);
  });

  it('honors the limit', () => {
    const { d } = freshDb();
    d.enqueue(bbJob('A'));
    d.enqueue(bbJob('B'));
    d.enqueue(bbJob('C'));
    expect(d.claimDueJobs(d.now(), 2)).toHaveLength(2);
  });

  it('does not let a sibling leapfrog a rescheduled head (fork-under-retry)', () => {
    const { d } = freshDb();
    d.enqueue(bbJob('A')); // id1
    d.enqueue(bbJob('A')); // id2
    const head = d.claimDueJobs(d.now(), 10)[0]!;
    // First post 5xx's -> reschedule into the future.
    d.reschedule(head.id, 1, d.now() + 5_000, 'boom');
    // Sibling must NOT leapfrog while the head is pending (just not yet due).
    expect(d.claimDueJobs(d.now(), 10)).toHaveLength(0);
    // Once the head is due again, it (not the sibling) is the claimable job.
    const next = d.claimDueJobs(d.now() + 5_000, 10);
    expect(next).toHaveLength(1);
    expect(next[0]!.id).toBe(head.id);
    expect(next[0]!.attempts).toBe(1);
    expect(next[0]!.last_error).toBe('boom');
  });
});

describe('outbox state transitions', () => {
  it('markDone / markDead remove a job from the claimable set', () => {
    const { d } = freshDb();
    d.enqueue(bbJob('A'));
    d.enqueue(bbJob('B'));
    const [a, b] = d.claimDueJobs(d.now(), 10);
    d.markDone(a!.id);
    d.markDead(b!.id, 'permanent');
    expect(d.claimDueJobs(d.now(), 10)).toHaveLength(0);
  });

  it('leases claimed jobs so an overlapping claim cannot re-claim them', () => {
    const { d } = freshDb();
    d.enqueue(bbJob('A')); // id1 head A
    d.enqueue(bbJob('A')); // id2 sibling A (barriered)
    d.enqueue(bbJob('B')); // id3 head B

    // First claim leases the heads of A and B; they flip out of 'pending'.
    const first = d.claimDueJobs(d.now(), 10);
    expect(first.map((r) => r.chat_guid).sort()).toEqual(['A', 'B']);
    expect(first.every((r) => r.status === 'claimed')).toBe(true);

    // A concurrent/overlapping pass sees nothing: A's head is leased (so its
    // sibling stays barriered) and B's head is leased.
    expect(d.claimDueJobs(d.now(), 10)).toHaveLength(0);

    // Settling the leased heads frees A's sibling (B is now empty).
    for (const r of first) d.markDone(r.id);
    const second = d.claimDueJobs(d.now(), 10);
    expect(second.map((r) => r.chat_guid)).toEqual(['A']);
  });

  it('keeps the barrier closed against siblings while the head is claimed', () => {
    const { d } = freshDb();
    d.enqueue(bbJob('A')); // id1
    d.enqueue(bbJob('A')); // id2
    d.claimDueJobs(d.now(), 10); // leases id1 (claimed)
    // id2 must not leapfrog the still-in-flight (claimed) head id1.
    expect(d.claimDueJobs(d.now(), 10)).toHaveLength(0);
  });

  it('requeueClaimed recovers leases orphaned by a crash mid-dispatch', () => {
    const { d } = freshDb();
    d.enqueue(bbJob('A'));
    d.enqueue(bbJob('B'));
    const claimed = d.claimDueJobs(d.now(), 10);
    expect(claimed).toHaveLength(2); // both leased ('claimed')

    // Simulate a crash: the worker never settled them. Recover on boot.
    d.requeueClaimed();
    const reclaimed = d.claimDueJobs(d.now(), 10);
    expect(reclaimed.map((r) => r.chat_guid).sort()).toEqual(['A', 'B']);
  });

  it('a state transition only acts on a row this pass holds the lease for', () => {
    const { d } = freshDb();
    d.enqueue(bbJob('A'));
    const [job] = d.claimDueJobs(d.now(), 10);
    d.markDone(job!.id); // claimed -> done
    // A stale reschedule of an already-done row is a no-op (status guard).
    d.reschedule(job!.id, 5, d.now() + 1, 'stale');
    const row = d.raw
      .query('SELECT status, attempts FROM outbox WHERE id = $id')
      .get({ id: job!.id }) as { status: string; attempts: number };
    expect(row.status).toBe('done');
    expect(row.attempts).toBe(0);
  });
});

describe('per-sub-post delivery ledger (#7)', () => {
  it('records and reports delivered sub-post external_ids', () => {
    const { d } = freshDb();
    expect(d.isPostDelivered('bb-msg-g1:att0')).toBe(false);
    d.markPostDelivered('bb-msg-g1:att0');
    expect(d.isPostDelivered('bb-msg-g1:att0')).toBe(true);
    // A distinct sub-post is independent.
    expect(d.isPostDelivered('bb-msg-g1:att1')).toBe(false);
    // Idempotent (INSERT OR IGNORE).
    d.markPostDelivered('bb-msg-g1:att0');
    expect(d.isPostDelivered('bb-msg-g1:att0')).toBe(true);
  });
});

describe('chat_map', () => {
  it('maps, reads by guid/conversation, and COALESCEs the conversation id', () => {
    const { d } = freshDb();
    const created = d.mapChat('G', 'bb-chat-G');
    expect(created.reference).toBe('bb-chat-G');
    expect(created.conversation_id).toBeNull();

    expect(d.getChatByGuid('missing')).toBeNull();
    expect(d.getChatByConversation('conv-1')).toBeNull();

    d.mapChat('G', 'bb-chat-G', 'conv-1');
    expect(d.getChatByGuid('G')?.conversation_id).toBe('conv-1');
    expect(d.getChatByConversation('conv-1')?.chat_guid).toBe('G');

    // A later map with no convId must NOT clobber the bound one (COALESCE).
    d.mapChat('G', 'bb-chat-G');
    expect(d.getChatByGuid('G')?.conversation_id).toBe('conv-1');
  });

  it('binds a conversation onto a known chat', () => {
    const { d } = freshDb();
    d.mapChat('G2', 'bb-chat-G2');
    d.bindConversation('G2', 'conv-2');
    expect(d.getChatByGuid('G2')?.conversation_id).toBe('conv-2');
  });
});

describe('handle_map', () => {
  it('upserts and reads handles, including null names', () => {
    const { d } = freshDb();
    expect(d.getHandle('+1')).toBeNull();
    d.upsertHandle('+1', 'Alice');
    expect(d.getHandle('+1')?.name).toBe('Alice');
    d.upsertHandle('+1', null);
    expect(d.getHandle('+1')?.name).toBeNull();
  });
});

describe('message cache', () => {
  it('caches and resolves chat + text, with conflict upsert', () => {
    const { d } = freshDb();
    d.cacheMessage('m1', 'cA', 'hi', false);
    expect(d.lookupChatForMessage('m1')).toBe('cA');
    expect(d.getMessageText('m1')).toBe('hi');

    // Conflict update changes both chat and text + is_from_me flag.
    d.cacheMessage('m1', 'cB', 'edited', true);
    expect(d.lookupChatForMessage('m1')).toBe('cB');
    expect(d.getMessageText('m1')).toBe('edited');
  });

  it('returns null for unknown guids and null text', () => {
    const { d } = freshDb();
    expect(d.lookupChatForMessage('nope')).toBeNull();
    expect(d.getMessageText('nope')).toBeNull();
    d.cacheMessage('m2', 'cA', null, false);
    expect(d.getMessageText('m2')).toBeNull();
  });
});

describe('sent_map + echo correlation', () => {
  it('records, reads, sets bb_guid, finds by bb_guid, and updates status', () => {
    const { d } = freshDb();
    d.recordSend({ tempGuid: 't1', chatGuid: 'cA', missiveMsgId: 'm1', text: 'yo' });
    const row = d.getSendByMissiveId('m1');
    expect(row?.temp_guid).toBe('t1');
    expect(row?.echo_consumed).toBe(0);
    expect(row?.bb_guid).toBeNull();
    expect(d.getSendByMissiveId('absent')).toBeNull();

    d.setSendBbGuid('t1', 'BB1');
    expect(d.findEchoByBbGuid('BB1')?.temp_guid).toBe('t1');
    expect(d.findEchoByBbGuid('absent')).toBeNull();

    d.markSendStatus('t1', 'failed');
    expect(d.getSendByMissiveId('m1')?.status).toBe('failed');
  });

  it('backfills a null chat guid so a chat/new echo becomes consumable (invariant #3/#5)', () => {
    const { d } = freshDb();
    // A new-conversation send is recorded pre-send with a null chat guid.
    d.recordSend({ tempGuid: 't-new', chatGuid: null, missiveMsgId: 'm-new', text: 'first hi' });
    // Before the backfill the echo (carrying the real chat guid) cannot match.
    expect(d.consumeEcho({ chatGuid: 'NEWCHAT', text: 'first hi', sinceMs: 0 })).toBeNull();

    // chat/new resolves the chat guid -> backfill it onto the send.
    d.setSendChatGuid('t-new', 'NEWCHAT');
    expect(d.getSendByMissiveId('m-new')?.chat_guid).toBe('NEWCHAT');

    // Now the new conversation's own first-message echo is consumed and dropped.
    const hit = d.consumeEcho({
      chatGuid: 'NEWCHAT',
      text: 'first hi',
      bbGuid: 'BB-NEW',
      sinceMs: 0,
    });
    expect(hit?.temp_guid).toBe('t-new');
    expect(hit?.echo_consumed).toBe(1);
  });

  it('(a) drops on exact bb_guid match', () => {
    const { d } = freshDb();
    d.recordSend({ tempGuid: 't1', chatGuid: 'cA', missiveMsgId: 'm1', text: 'hi' });
    d.setSendBbGuid('t1', 'BBX');
    const hit = d.consumeEcho({ chatGuid: 'cA', text: 'hi', bbGuid: 'BBX', sinceMs: 0 });
    expect(hit?.temp_guid).toBe('t1');
  });

  it('(b) consumes the oldest unconsumed row per echo (two identical msgs)', () => {
    let t = 1_000;
    const d = createDb(':memory:', () => t);
    d.recordSend({ tempGuid: 't1', chatGuid: 'cA', missiveMsgId: 'm1', text: 'dup' });
    t = 2_000;
    d.recordSend({ tempGuid: 't2', chatGuid: 'cA', missiveMsgId: 'm2', text: 'dup' });

    const first = d.consumeEcho({ chatGuid: 'cA', text: 'dup', bbGuid: 'G1', sinceMs: 0 });
    expect(first?.temp_guid).toBe('t1');
    expect(first?.echo_consumed).toBe(1);
    expect(first?.bb_guid).toBe('G1'); // COALESCE(null, G1)

    const second = d.consumeEcho({ chatGuid: 'cA', text: 'dup', bbGuid: 'G2', sinceMs: 0 });
    expect(second?.temp_guid).toBe('t2');

    // Both consumed -> a third identical echo finds nothing.
    expect(d.consumeEcho({ chatGuid: 'cA', text: 'dup', bbGuid: 'G3', sinceMs: 0 })).toBeNull();
    d.close();
  });

  it('(b) matches without a bbGuid correlator and on null text', () => {
    const { d } = freshDb();
    d.recordSend({ tempGuid: 't1', chatGuid: 'cA', missiveMsgId: 'm1', text: null });
    const hit = d.consumeEcho({ chatGuid: 'cA', text: null, sinceMs: 0 });
    expect(hit?.temp_guid).toBe('t1');
    expect(hit?.bb_guid).toBeNull(); // row null, no bbGuid arg
  });

  it('(b) keeps an existing bb_guid via COALESCE', () => {
    const { d } = freshDb();
    d.recordSend({ tempGuid: 't1', chatGuid: 'cA', missiveMsgId: 'm1', text: 'hi' });
    d.setSendBbGuid('t1', 'EXIST');
    // bbGuid 'OTHER' does not exact-match, so (b) runs; COALESCE keeps EXIST.
    const hit = d.consumeEcho({ chatGuid: 'cA', text: 'hi', bbGuid: 'OTHER', sinceMs: 0 });
    expect(hit?.bb_guid).toBe('EXIST');
  });

  it('does not suppress beyond the recency window', () => {
    let t = 1_000;
    const d = createDb(':memory:', () => t);
    d.recordSend({ tempGuid: 't1', chatGuid: 'cA', missiveMsgId: 'm1', text: 'old' });
    t = 1_000 + 6 * 60 * 1_000; // +6 minutes
    const sinceMs = t - 5 * 60 * 1_000; // last 5 minutes only
    expect(d.consumeEcho({ chatGuid: 'cA', text: 'old', sinceMs })).toBeNull();
    // Widen the window -> it matches.
    expect(d.consumeEcho({ chatGuid: 'cA', text: 'old', sinceMs: 0 })?.temp_guid).toBe('t1');
    d.close();
  });

  it('returns null when nothing matches', () => {
    const { d } = freshDb();
    d.recordSend({ tempGuid: 't1', chatGuid: 'cA', missiveMsgId: 'm1', text: 'hi' });
    expect(d.consumeEcho({ chatGuid: 'cA', text: 'different', sinceMs: 0 })).toBeNull();
  });

  it('matches an attachment echo on the attachment signature, not on text (#5)', () => {
    const { d } = freshDb();
    // An attachment send (captionless) and a sibling text send in the same chat.
    d.recordSend({
      tempGuid: 't-att',
      chatGuid: 'cA',
      missiveMsgId: 'm-att',
      text: null,
      attSig: 'att:1',
    });
    d.recordSend({ tempGuid: 't-txt', chatGuid: 'cA', missiveMsgId: 'm-txt', text: 'caption' });

    // A null-text attachment echo must NOT consume the text row; it matches the
    // att_sig row only.
    const hit = d.consumeEcho({ chatGuid: 'cA', text: null, attSig: 'att:1', sinceMs: 0 });
    expect(hit?.temp_guid).toBe('t-att');
    expect(d.getSendByMissiveId('m-txt')?.echo_consumed).toBe(0);
  });

  it('distinguishes attachment echoes by count (att:2 vs att:1)', () => {
    const { d } = freshDb();
    d.recordSend({
      tempGuid: 't1',
      chatGuid: 'cA',
      missiveMsgId: 'm1',
      text: null,
      attSig: 'att:1',
    });
    d.recordSend({
      tempGuid: 't2',
      chatGuid: 'cA',
      missiveMsgId: 'm2',
      text: null,
      attSig: 'att:2',
    });

    // A 2-file echo consumes the att:2 row, leaving the att:1 row untouched.
    const hit = d.consumeEcho({ chatGuid: 'cA', text: null, attSig: 'att:2', sinceMs: 0 });
    expect(hit?.temp_guid).toBe('t2');
    expect(d.getSendByMissiveId('m1')?.echo_consumed).toBe(0);
  });

  it('a text echo does not consume an attachment send row', () => {
    const { d } = freshDb();
    d.recordSend({
      tempGuid: 't-att',
      chatGuid: 'cA',
      missiveMsgId: 'm-att',
      text: null,
      attSig: 'att:1',
    });
    // Text echo (no attSig) -> only att_sig IS NULL rows are eligible -> no match.
    expect(d.consumeEcho({ chatGuid: 'cA', text: null, sinceMs: 0 })).toBeNull();
  });
});

describe('monitoring helpers', () => {
  describe('outboxCounts', () => {
    it('returns zero counts for an empty outbox', () => {
      const { d } = freshDb();
      expect(d.outboxCounts()).toEqual({ pending: 0, claimed: 0, done: 0, dead: 0 });
    });

    it('tallies rows across all four statuses', () => {
      const { d } = freshDb();

      d.enqueue(bbJob('B'));
      d.claimDueJobs(d.now(), 10); // B -> claimed, left claimed

      d.enqueue(bbJob('C'));
      const cJob = d.claimDueJobs(d.now(), 10).find((r) => r.chat_guid === 'C')!;
      d.markDone(cJob.id);

      d.enqueue(bbJob('D'));
      const dJob = d.claimDueJobs(d.now(), 10).find((r) => r.chat_guid === 'D')!;
      d.markDead(dJob.id, 'boom');

      // Enqueued last, and no further claim pass runs, so it stays pending.
      d.enqueue(bbJob('A'));

      expect(d.outboxCounts()).toEqual({ pending: 1, claimed: 1, done: 1, dead: 1 });
    });
  });

  describe('listDeadJobs', () => {
    it('lists dead jobs newest-first, respects the limit, and parses payload', () => {
      const { d } = freshDb();
      const ids: number[] = [];
      for (const payload of [{ n: 1 }, { n: 2 }, { n: 3 }]) {
        d.enqueue({ kind: 'bb_send', chat_guid: 'A', payload });
        const [job] = d.claimDueJobs(d.now(), 10);
        d.markDead(job!.id, 'fail');
        ids.push(job!.id);
      }

      const dead = d.listDeadJobs(10);
      expect(dead.map((r) => r.id)).toEqual([...ids].reverse());
      expect(dead.every((r) => r.status === 'dead')).toBe(true);
      expect(dead[0]?.payload).toEqual({ n: 3 });

      expect(d.listDeadJobs(2)).toHaveLength(2);
    });

    it('returns an empty array when there are no dead jobs', () => {
      const { d } = freshDb();
      expect(d.listDeadJobs(10)).toEqual([]);
    });
  });

  describe('activitySince', () => {
    it('counts inbound/outbound/echoesSuppressed with boundary inclusivity and exclusions', () => {
      const { d, at } = freshDb();

      at(1_000);
      d.cacheMessage('old-in', 'cA', 'old', false); // before cutoff -> excluded from inbound
      d.recordSend({ tempGuid: 'old-out', chatGuid: 'cA', missiveMsgId: 'm-old', text: 'old-out' }); // before cutoff -> excluded from outbound
      d.recordSend({
        tempGuid: 'old-echo',
        chatGuid: 'cA',
        missiveMsgId: 'm-old-echo',
        text: 'old-echo',
      }); // consumed but before cutoff -> excluded from echoesSuppressed
      expect(d.consumeEcho({ chatGuid: 'cA', text: 'old-echo', sinceMs: 0 })?.temp_guid).toBe(
        'old-echo',
      );

      at(2_000);
      d.cacheMessage('in-1', 'cA', 'hi', false); // at cutoff, inbound -> counted (boundary inclusive)
      d.cacheMessage('in-me', 'cA', 'hi', true); // is_from_me=1 -> excluded from inbound
      d.recordSend({ tempGuid: 'out-1', chatGuid: 'cA', missiveMsgId: 'm1', text: 'out-1' }); // at cutoff -> counted
      d.recordSend({ tempGuid: 'out-2', chatGuid: 'cA', missiveMsgId: 'm2', text: 'out-2' }); // never consumed -> excluded from echoesSuppressed
      expect(d.consumeEcho({ chatGuid: 'cA', text: 'out-1', sinceMs: 0 })?.temp_guid).toBe('out-1');

      expect(d.activitySince(2_000)).toEqual({ inbound: 1, outbound: 2, echoesSuppressed: 1 });
    });

    it('returns zero counts when nothing has happened since the cutoff', () => {
      const { d } = freshDb();
      expect(d.activitySince(d.now())).toEqual({ inbound: 0, outbound: 0, echoesSuppressed: 0 });
    });
  });

  describe('retryDead', () => {
    it('returns "missing" for an unknown id', () => {
      const { d } = freshDb();
      expect(d.retryDead(999)).toBe('missing');
    });

    it('returns "not-dead" and leaves a pending job unchanged', () => {
      const { d } = freshDb();
      d.enqueue(bbJob('A'));
      const before = d.raw.query('SELECT * FROM outbox WHERE chat_guid = $c').get({ c: 'A' });
      const id = (before as { id: number }).id;

      expect(d.retryDead(id)).toBe('not-dead');

      const after = d.raw.query('SELECT * FROM outbox WHERE chat_guid = $c').get({ c: 'A' });
      expect(after).toEqual(before);
    });

    it('revives a dead job to pending with a fresh attempt budget and clears the error', () => {
      const { d } = freshDb();
      d.enqueue(bbJob('A'));
      const [job] = d.claimDueJobs(d.now(), 10);
      d.reschedule(job!.id, 3, d.now(), 'transient'); // bump attempts before it eventually dies
      const [reclaimed] = d.claimDueJobs(d.now(), 10);
      d.markDead(reclaimed!.id, 'permanent failure');

      expect(d.retryDead(job!.id)).toBe('retried');

      const row = d.raw
        .query('SELECT status, attempts, next_at, last_error FROM outbox WHERE id = $id')
        .get({ id: job!.id }) as {
        status: string;
        attempts: number;
        next_at: number;
        last_error: string | null;
      };
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(0);
      expect(row.next_at).toBe(d.now());
      expect(row.last_error).toBeNull();

      // The revived row is claimable again.
      const claimed = d.claimDueJobs(d.now(), 10);
      expect(claimed.map((r) => r.id)).toContain(job!.id);
    });
  });
});

describe('pruneOld', () => {
  it('drops aged dedup ledger, message cache, and done outbox rows', () => {
    let t = 1_000;
    const d = createDb(':memory:', () => t);

    // Aged rows.
    d.dedupAndEnqueue('seen-old', bbJob('A'));
    const oldJob = d.claimDueJobs(t, 10)[0]!;
    d.markDone(oldJob.id);
    d.cacheMessage('m-old', 'cA', 'old', false);

    // Recent rows.
    t = 10_000;
    d.cacheMessage('m-new', 'cA', 'new', false);
    d.enqueue(bbJob('B')); // pending, recent

    d.pruneOld(5_000);

    // Aged dedup id is free again; aged message + done outbox gone.
    expect(d.dedupAndEnqueue('seen-old', bbJob('A'))).toBe(true);
    expect(d.getMessageText('m-old')).toBeNull();
    expect(d.getMessageText('m-new')).toBe('new');
    // The recent pending job survived (plus the re-enqueued seen-old job).
    expect(d.claimDueJobs(20_000, 10).length).toBeGreaterThanOrEqual(1);
    d.close();
  });
});

describe('module singleton', () => {
  it('exposes a shared db with a working clock', () => {
    expect(db).toBeDefined();
    expect(typeof now()).toBe('number');
    setClock(() => 123);
    expect(now()).toBe(123);
    setClock(null);
  });
});

afterEach(() => {
  // Keep the singleton clock pristine for other test files.
  setClock(null);
});
