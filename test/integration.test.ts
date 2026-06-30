/**
 * Integration tests — the real routes + outbox worker + domain planners +
 * BlueBubbles/Missive clients, driven end to end over real HTTP against
 * `Bun.serve` mock servers (see `test/support/mocks.ts`).
 *
 * Both webhook endpoints are exercised through `app.handle()`; the durable
 * outbox is drained with the genuine {@link drainOutbox} (a custom `fetch` routes
 * the clients' real requests to the mocks). Coverage focus: the high-risk
 * invariants observable end to end — inbound `messages` body shape (#6/#7),
 * attachment download+inline, outbound single-send (#3, no double-send),
 * echo consume-on-match for both replies AND new conversations (#5), bad-HMAC
 * rejection, and 429 `Retry-After` rescheduling.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { config } from '../src/config.ts';
import { createDb, type Db } from '../src/db.ts';
import { detect, getCaps } from '../src/domain/capability.ts';
import type { Logger } from '../src/logger.ts';
import { drainOutbox, type WorkerDeps } from '../src/queue/outbox.ts';
import { createLimiter } from '../src/queue/ratelimiter.ts';
import { bbWebhookRoute } from '../src/routes/bb-webhook.ts';
import { healthRoute } from '../src/routes/health.ts';
import { missiveWebhookRoute } from '../src/routes/missive-webhook.ts';
import type { MissiveInboundBody } from '../src/types.ts';
import {
  bbWebhookRequest,
  type MockBlueBubbles,
  type MockMissive,
  makeRoutingFetch,
  missiveWebhookRequest,
  startMockBlueBubbles,
  startMockMissive,
} from './support/mocks.ts';

/** A silent logger (the integration assertions read state, not log lines). */
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Fixed clock so inbound timestamps + echo windows are deterministic. */
const FIXED = 1_700_000_000_000;

let bb: MockBlueBubbles;
let missive: MockMissive;
let routingFetch: typeof fetch;

beforeAll(() => {
  bb = startMockBlueBubbles();
  missive = startMockMissive();
  routingFetch = makeRoutingFetch(bb.origin, missive.origin, fetch);
});

afterAll(async () => {
  await bb.stop();
  await missive.stop();
});

beforeEach(() => {
  bb.reset();
  missive.reset();
});

/** A fresh isolated harness: in-memory DB, composed app, worker deps. */
function harness(): { db: Db; app: Elysia; deps: WorkerDeps } {
  const db = createDb(':memory:', () => FIXED);
  const app = new Elysia()
    .use(missiveWebhookRoute({ db, logger, hmacSecret: config.MISSIVE_HMAC_SECRET }))
    .use(bbWebhookRoute({ db, logger, hookToken: config.BB_HOOK_TOKEN }))
    .use(healthRoute({ db, getCaps, isReady: () => true })) as unknown as Elysia;
  const deps: WorkerDeps = { db, limiter: createLimiter(), logger, fetch: routingFetch };
  return { db, app, deps };
}

/** Drain the outbox to quiescence (claims head-of-line jobs across passes). */
async function drainAll(deps: WorkerDeps): Promise<void> {
  // Each pass claims due, barrier-eligible jobs; loop until nothing is due.
  while ((await drainOutbox(deps)) > 0) {
    /* keep draining */
  }
}

/** Pending (undispatched) outbox depth for a db. */
function pending(db: Db): number {
  return Number(
    (
      db.raw.query("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'").get() as {
        n: number;
      }
    ).n,
  );
}

describe('inbound: BlueBubbles -> Missive', () => {
  it('posts a genuine text message with the exact contract shape (#6/#7)', async () => {
    const { db, app, deps } = harness();
    db.upsertHandle('+15551112222', 'Alice'); // cached display name

    const res = await app.handle(
      bbWebhookRequest({
        type: 'new-message',
        data: {
          guid: 'g-in-1',
          text: 'hello world',
          isFromMe: false,
          handle: { address: '+15551112222' },
          chats: [{ guid: 'chatA', displayName: 'Alice & Me' }],
          dateCreated: FIXED,
        },
      }),
    );
    expect(res.status).toBe(200);

    await drainAll(deps);

    expect(missive.posts).toHaveLength(1);
    const { messages } = missive.posts[0] as MissiveInboundBody;
    expect(messages.account).toBe(config.MISSIVE_ACCOUNT_ID);
    expect(messages.references).toEqual(['bb-chat-chatA']);
    expect(messages.external_id).toBe('bb-msg-g-in-1');
    expect(messages.to_fields[0]?.id).toBe(config.SELF_HANDLE);
    expect(messages.from_field.id).toBe('+15551112222');
    expect(messages.from_field.name).toBe('Alice');
    expect(messages.body).toBe('hello world');
    expect(messages.delivered_at).toBe(Math.floor(FIXED / 1000));
  });

  it('downloads attachment bytes over HTTP and inlines them as base64', async () => {
    const { app, deps } = harness();
    bb.state.attachmentBytes = new Uint8Array([10, 20, 30, 40]);

    await app.handle(
      bbWebhookRequest({
        type: 'new-message',
        data: {
          guid: 'g-att-1',
          text: 'a pic',
          isFromMe: false,
          handle: { address: '+1999' },
          chats: [{ guid: 'chatB' }],
          attachments: [{ guid: 'att-1', transferName: 'photo.jpg', totalBytes: 4 }],
          dateCreated: FIXED,
        },
      }),
    );

    await drainAll(deps);

    expect(missive.posts).toHaveLength(1);
    const { messages } = missive.posts[0] as MissiveInboundBody;
    expect(messages.attachments?.[0]?.filename).toBe('photo.jpg');
    expect(messages.attachments?.[0]?.base64_data).toBe(
      Buffer.from([10, 20, 30, 40]).toString('base64'),
    );
    // The worker actually fetched the bytes from BlueBubbles.
    expect(bb.requests.some((r) => /^\/attachment\/att-1\/download/.test(r.path))).toBe(true);
  });
});

describe('outbound: Missive -> BlueBubbles (single send, #3)', () => {
  it('replies into a known chat via exactly one /message/text (no double-send)', async () => {
    const { db, app, deps } = harness();
    db.mapChat('chatReply', 'bb-chat-chatReply', 'conv-reply'); // known, bound chat

    const res = await app.handle(
      missiveWebhookRequest({
        message: {
          id: 'mo-1',
          type: 'custom_text',
          body: 'reply text',
          to_fields: [{ id: '+1555' }],
          references: [],
        },
        conversation: { id: 'conv-reply' },
      }),
    );
    expect(res.status).toBe(200);

    await drainAll(deps);

    expect(bb.count('POST', '/message/text')).toBe(1);
    expect(bb.count('POST', '/chat/new')).toBe(0);
    const sent = bb.requests.find((r) => r.path === '/message/text')?.body as {
      chatGuid: string;
      tempGuid: string;
      message: string;
      method: string;
    };
    expect(sent.chatGuid).toBe('chatReply');
    expect(sent.message).toBe('reply text');
    expect(sent.method).toBe('apple-script');
    expect(typeof sent.tempGuid).toBe('string');

    const rec = db.getSendByMissiveId('mo-1');
    expect(rec?.chat_guid).toBe('chatReply');
    expect(rec?.bb_guid).toBe('bb-text-1'); // captured from the mock's response
  });

  it('creates a brand-new conversation via exactly one /chat/new (never also /message/text)', async () => {
    const { db, app, deps } = harness();
    bb.state.newChatGuid = 'iMessage;-;+19998887777';

    await app.handle(
      missiveWebhookRequest({
        message: {
          id: 'mo-2',
          type: 'custom_text',
          body: 'first contact',
          to_fields: [{ id: '+19998887777' }],
          references: [],
        },
        conversation: { id: 'conv-new-x' },
      }),
    );

    await drainAll(deps);

    expect(bb.count('POST', '/chat/new')).toBe(1);
    expect(bb.count('POST', '/message/text')).toBe(0); // invariant #3: no double send
    const created = bb.requests.find((r) => r.path === '/chat/new')?.body as {
      addresses: string[];
      message: string;
      method: string;
      tempGuid: string;
    };
    expect(created.addresses).toEqual(['+19998887777']);
    expect(created.message).toBe('first contact');
    expect(created.method).toBe('apple-script');

    // Chat mapped + conversation bound, and the send's chat guid backfilled (#3/#5).
    expect(db.getChatByGuid('iMessage;-;+19998887777')?.conversation_id).toBe('conv-new-x');
    expect(db.getSendByMissiveId('mo-2')?.chat_guid).toBe('iMessage;-;+19998887777');
  });
});

describe('echo suppression (no echo loop, #5)', () => {
  it('drops the reply echo BlueBubbles sends back (known chat)', async () => {
    const { db, app, deps } = harness();
    db.mapChat('chatReply', 'bb-chat-chatReply', 'conv-reply');

    // Agent reply out -> /message/text.
    await app.handle(
      missiveWebhookRequest({
        message: { id: 'mo-1', type: 'custom_text', body: 'pong', to_fields: [], references: [] },
        conversation: { id: 'conv-reply' },
      }),
    );
    await drainAll(deps);
    expect(bb.count('POST', '/message/text')).toBe(1);

    // BlueBubbles echoes it back as new-message(isFromMe) with a NEW guid.
    await app.handle(
      bbWebhookRequest({
        type: 'new-message',
        data: {
          guid: 'g-echo-1',
          text: 'pong',
          isFromMe: true,
          handle: null,
          chats: [{ guid: 'chatReply' }],
          dateCreated: FIXED,
        },
      }),
    );
    await drainAll(deps);

    expect(missive.posts).toHaveLength(0); // echo suppressed, not re-posted
    expect(db.getSendByMissiveId('mo-1')?.echo_consumed).toBe(1);
  });

  it('drops the first-message echo of a brand-new conversation (chat/new path)', async () => {
    const { db, app, deps } = harness();
    bb.state.newChatGuid = 'iMessage;-;newconv';

    await app.handle(
      missiveWebhookRequest({
        message: {
          id: 'mo-3',
          type: 'custom_text',
          body: 'newconv hi',
          to_fields: [{ id: '+15550009999' }],
          references: [],
        },
        conversation: { id: 'conv-nc' },
      }),
    );
    await drainAll(deps);
    expect(bb.count('POST', '/chat/new')).toBe(1);

    // The echo arrives carrying the REAL chat guid (not the null recorded pre-send).
    await app.handle(
      bbWebhookRequest({
        type: 'new-message',
        data: {
          guid: 'g-echo-nc',
          text: 'newconv hi',
          isFromMe: true,
          handle: null,
          chats: [{ guid: 'iMessage;-;newconv' }],
          dateCreated: FIXED,
        },
      }),
    );
    await drainAll(deps);

    expect(missive.posts).toHaveLength(0); // suppressed via the backfilled chat guid
    expect(db.getSendByMissiveId('mo-3')?.echo_consumed).toBe(1);
  });
});

describe('webhook security + reliability', () => {
  it('rejects a tampered Missive signature with 401 and performs no BlueBubbles work', async () => {
    const { app, deps } = harness();
    const res = await app.handle(
      new Request('http://bridge.local/missive/webhook', {
        method: 'POST',
        body: JSON.stringify({ message: { id: 'x' }, conversation: { id: 'c' } }),
        headers: { 'X-Hook-Signature': 'sha256=deadbeef' },
      }),
    );
    expect(res.status).toBe(401);

    await drainAll(deps);
    expect(bb.count('POST', '/message/text')).toBe(0);
    expect(bb.count('POST', '/chat/new')).toBe(0);
  });

  it('honors a Missive 429 Retry-After exactly, then succeeds on the retry', async () => {
    let clock = FIXED;
    const db = createDb(':memory:', () => clock);
    const app = new Elysia()
      .use(bbWebhookRoute({ db, logger, hookToken: config.BB_HOOK_TOKEN }))
      .use(
        missiveWebhookRoute({ db, logger, hmacSecret: config.MISSIVE_HMAC_SECRET }),
      ) as unknown as Elysia;
    const deps: WorkerDeps = { db, limiter: createLimiter(), logger, fetch: routingFetch };

    missive.state.failNext = 1;
    missive.state.failStatus = 429;
    missive.state.retryAfterSec = 7;

    await app.handle(
      bbWebhookRequest({
        type: 'new-message',
        data: {
          guid: 'g-429',
          text: 'rate me',
          isFromMe: false,
          handle: { address: '+1222' },
          chats: [{ guid: 'chat429' }],
          dateCreated: FIXED,
        },
      }),
    );

    // First pass -> 429 -> reschedule exactly Retry-After (7s) into the future.
    await drainOutbox(deps);
    const row = db.raw.query('SELECT attempts, status, next_at FROM outbox LIMIT 1').get() as {
      attempts: number;
      status: string;
      next_at: number;
    };
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.next_at).toBe(FIXED + 7000);
    expect(missive.posts).toHaveLength(0);

    // Advance past the Retry-After -> the job is due and succeeds.
    clock = FIXED + 7000;
    await drainAll(deps);
    expect(missive.posts).toHaveLength(1);
    expect(pending(db)).toBe(0);
  });
});

describe('capability detection over HTTP', () => {
  it('reflects server/info Private-API flags and degrades when off', async () => {
    bb.state.privateApi = true;
    bb.state.helperConnected = true;
    expect((await detect({ fetch: routingFetch })).privateApi).toBe(true);
    expect(getCaps().privateApi).toBe(true);

    bb.state.privateApi = false; // helper alone is insufficient
    bb.state.helperConnected = true;
    expect((await detect({ fetch: routingFetch })).privateApi).toBe(false);
    expect(getCaps().privateApi).toBe(false);
  });
});

describe('outbound chat resolution end to end', () => {
  it('replies by a references token into the resolved chat (reply-by-reference)', async () => {
    const { db, app, deps } = harness();
    db.mapChat('chatRef', 'bb-chat-chatRef'); // known chat, conversation NOT bound

    await app.handle(
      missiveWebhookRequest({
        message: {
          id: 'mo-ref',
          type: 'custom_text',
          body: 'ref reply',
          to_fields: [{ id: '+1' }],
          references: ['bb-chat-chatRef'],
        },
        conversation: { id: 'conv-unbound' }, // unmapped -> falls through to references
      }),
    );
    await drainAll(deps);

    expect(bb.count('POST', '/chat/new')).toBe(0);
    const sent = bb.requests.find((r) => r.path === '/message/text')?.body as { chatGuid: string };
    expect(sent.chatGuid).toBe('chatRef');
  });

  it('replies into an existing 1:1 chat resolved from the recipient (reply-known-chat)', async () => {
    const { db, app, deps } = harness();
    db.mapChat('iMessage;-;+15559998888', 'bb-chat-iMessage;-;+15559998888'); // existing DM

    await app.handle(
      missiveWebhookRequest({
        message: {
          id: 'mo-dm',
          type: 'custom_text',
          body: 'dm reply',
          to_fields: [{ id: '+15559998888' }],
          references: [],
        },
        conversation: { id: 'conv-dm-unbound' },
      }),
    );
    await drainAll(deps);

    expect(bb.count('POST', '/chat/new')).toBe(0);
    const sent = bb.requests.find((r) => r.path === '/message/text')?.body as { chatGuid: string };
    expect(sent.chatGuid).toBe('iMessage;-;+15559998888');
  });
});

describe('concurrency: per-chat barrier + lease (invariant #4)', () => {
  it('serializes two first-contact sends to one new number into a single chat/new (no fork)', async () => {
    const { app, deps } = harness();
    bb.state.newChatGuid = 'iMessage;-;+15551230000';

    const send = (id: string) =>
      app.handle(
        missiveWebhookRequest({
          message: {
            id,
            type: 'custom_text',
            body: `hi ${id}`,
            to_fields: [{ id: '+15551230000' }],
            references: [],
          },
          conversation: { id: 'conv-shared' },
        }),
      );
    await send('mo-a');
    await send('mo-b');

    // Both jobs share the deterministic DM barrier key, so the barrier serializes
    // them: the first creates+binds the chat, the second resolves it as a reply.
    await drainAll(deps);

    expect(bb.count('POST', '/chat/new')).toBe(1); // exactly one — no fork
    expect(bb.count('POST', '/message/text')).toBe(1); // second send replied into it
  });

  it('overlapping drain passes never double-dispatch the same job (lease)', async () => {
    const { db, app, deps } = harness();
    await app.handle(
      bbWebhookRequest({
        type: 'new-message',
        data: {
          guid: 'g-overlap',
          text: 'once',
          isFromMe: false,
          handle: { address: '+1' },
          chats: [{ guid: 'chatOverlap' }],
          dateCreated: FIXED,
        },
      }),
    );

    // Two drain passes racing: the first leases the job, the second sees it
    // claimed and processes nothing -> exactly one Missive POST.
    const [a, b] = await Promise.all([drainOutbox(deps), drainOutbox(deps)]);
    expect(a + b).toBe(1);
    expect(missive.posts).toHaveLength(1); // single POST, not duplicated
    expect(pending(db)).toBe(0); // the job settled exactly once
  });
});

describe('identity name caching over HTTP', () => {
  it('renders + caches the sender name resolved from BlueBubbles contacts', async () => {
    const { db, app, deps } = harness();
    bb.state.contactName = 'Resolved Rachel';

    await app.handle(
      bbWebhookRequest({
        type: 'new-message',
        data: {
          guid: 'g-name',
          text: 'hello',
          isFromMe: false,
          handle: { address: '+15551116666' },
          chats: [{ guid: 'chatName' }],
          dateCreated: FIXED,
        },
      }),
    );
    await drainAll(deps);

    const { messages } = missive.posts[0] as MissiveInboundBody;
    expect(messages.from_field.name).toBe('Resolved Rachel');
    // handle_map populated so subsequent inbound is a cache hit (no re-query).
    expect(db.getHandle('+15551116666')?.name).toBe('Resolved Rachel');
    expect(bb.count('POST', '/contact/query')).toBe(1);
  });
});

describe('RECEIPTS_AS_POSTS end to end', () => {
  it('turns a read-status webhook into a Missive Posts comment', async () => {
    const db = createDb(':memory:', () => FIXED);
    const app = new Elysia().use(
      bbWebhookRoute({ db, logger, hookToken: config.BB_HOOK_TOKEN, receiptsAsPosts: true }),
    ) as unknown as Elysia;
    const deps: WorkerDeps = {
      db,
      limiter: createLimiter(),
      logger,
      fetch: routingFetch,
      receiptsAsPosts: true,
    };
    db.mapChat('chatRcpt', 'bb-chat-chatRcpt', 'conv-rcpt'); // bound conversation

    await app.handle(
      bbWebhookRequest({
        type: 'chat-read-status-changed',
        data: { chatGuid: 'chatRcpt', read: true },
      }),
    );
    await drainAll(deps);

    expect(missive.comments).toHaveLength(1);
    expect(missive.comments[0]).toMatchObject({
      posts: { conversation: 'conv-rcpt', text: '✓✓ Read' },
    });
  });
});

describe('split-post durability (invariant #7)', () => {
  it('retry re-posts only the unfinished sub-post, never the delivered one', async () => {
    let clock = FIXED;
    const db = createDb(':memory:', () => clock);
    const app = new Elysia().use(
      bbWebhookRoute({ db, logger, hookToken: config.BB_HOOK_TOKEN }),
    ) as unknown as Elysia;
    const deps: WorkerDeps = { db, limiter: createLimiter(), logger, fetch: routingFetch };

    // A text + an oversize attachment splits into a :text post and an :att0
    // placeholder post. Fail ONLY the placeholder on the first attempt.
    missive.state.failExternalId = ':att0';
    await app.handle(
      bbWebhookRequest({
        type: 'new-message',
        data: {
          guid: 'g-split',
          text: 'caption',
          isFromMe: false,
          handle: { address: '+1' },
          chats: [{ guid: 'chatSplit' }],
          attachments: [{ guid: 'huge', transferName: 'huge.mov', totalBytes: 20_000_000 }],
          dateCreated: FIXED,
        },
      }),
    );

    // First pass: :text lands, :att0 503s -> the job reschedules (partial delivery).
    await drainOutbox(deps);
    expect(missive.posts.map((p) => p.messages.external_id)).toEqual(['bb-msg-g-split:text']);
    const row = db.raw.query('SELECT status, next_at FROM outbox LIMIT 1').get() as {
      status: string;
      next_at: number;
    };
    expect(row.status).toBe('pending');

    // Advance past backoff and drain: only :att0 is re-posted; :text is skipped
    // via the delivery ledger (no duplicate of the already-delivered sub-post).
    clock = row.next_at;
    await drainAll(deps);
    expect(missive.posts.map((p) => p.messages.external_id).sort()).toEqual([
      'bb-msg-g-split:att0',
      'bb-msg-g-split:text',
    ]);
    expect(
      missive.posts.filter((p) => p.messages.external_id === 'bb-msg-g-split:text'),
    ).toHaveLength(1);
    db.close();
  });
});

describe('outbound attachment fidelity (Private-API multipart)', () => {
  it('sends caption + photo as a single multipart message when the Private API is on', async () => {
    bb.state.privateApi = true;
    bb.state.helperConnected = true;
    await detect({ fetch: routingFetch }); // flip getCaps() -> privateApi
    const { db, app, deps } = harness();
    db.mapChat('chatMix', 'bb-chat-chatMix', 'conv-mix');

    await app.handle(
      missiveWebhookRequest({
        message: {
          id: 'mo-mix',
          type: 'custom_text',
          body: 'a caption',
          to_fields: [{ id: '+1' }],
          references: [],
          attachments: [{ filename: 'pic.png', media_type: 'image/png', base64_data: btoa('img') }],
        },
        conversation: { id: 'conv-mix' },
      }),
    );
    await drainAll(deps);

    expect(bb.count('POST', '/attachment/upload')).toBe(1);
    expect(bb.count('POST', '/message/multipart')).toBe(1);
    expect(bb.count('POST', '/message/attachment')).toBe(0); // not the apple-script path
    // restore caps for sibling tests
    bb.state.privateApi = false;
    bb.state.helperConnected = false;
    await detect({ fetch: routingFetch });
  });
});
