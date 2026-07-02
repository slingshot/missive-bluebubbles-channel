import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as bbClient from '../../src/clients/bluebubbles.ts';
import * as missiveClient from '../../src/clients/missive.ts';
import { createDb, type Db } from '../../src/db.ts';
import * as capability from '../../src/domain/capability.ts';
import type { InboundCtx } from '../../src/domain/inbound.ts';
import * as inboundDomain from '../../src/domain/inbound.ts';
import type { OutboundCtx } from '../../src/domain/outbound.ts';
import * as outboundDomain from '../../src/domain/outbound.ts';
import type { Logger } from '../../src/logger.ts';
import {
  dispatch,
  drainOutbox,
  enqueueJob,
  MAX_ATTEMPTS,
  startWorker,
  type WorkerDeps,
} from '../../src/queue/outbox.ts';
import type { Limiter } from '../../src/queue/ratelimiter.ts';
import type {
  BbMessage,
  BbWebhook,
  InboundPost,
  MissiveInboundBody,
  MissiveInboundMessage,
  MissiveOutAttachment,
  MissiveOutboundWebhook,
  OutboxRow,
  SendPlan,
} from '../../src/types.ts';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A capturing logger that records every emitted line. */
function makeLogger(): Logger & { calls: { level: string; msg: string }[] } {
  const calls: { level: string; msg: string }[] = [];
  const at =
    (level: string) =>
    (msg: string): void => {
      calls.push({ level, msg });
    };
  return { calls, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** A no-op limiter that runs work immediately (rate math is tested separately). */
const passthrough: Limiter = {
  acquire: () => Promise.resolve(() => undefined),
  run<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  },
  get inFlight() {
    return 0;
  },
};

type DepsOver = {
  maxAttempts?: number;
  batchSize?: number;
  pollMs?: number;
  receiptsAsPosts?: boolean;
  fetch?: typeof fetch;
};

function makeDeps(
  db: Db,
  over: DepsOver = {},
): WorkerDeps & { logger: ReturnType<typeof makeLogger> } {
  return { db, limiter: passthrough, logger: makeLogger(), ...over };
}

/** A fresh in-memory DB with a fixed clock. */
function freshDb(start = 1_000_000): Db {
  return createDb(':memory:', () => start);
}

/** Read the single outbox row's reliability columns. */
function outboxRow(db: Db): {
  attempts: number;
  status: string;
  last_error: string | null;
  next_at: number;
} {
  return db.raw.query('SELECT attempts, status, last_error, next_at FROM outbox LIMIT 1').get() as {
    attempts: number;
    status: string;
    last_error: string | null;
    next_at: number;
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeHook(over: {
  id?: string;
  text?: string;
  attachments?: MissiveOutAttachment[];
  conversationId?: string;
}): MissiveOutboundWebhook {
  return {
    message: {
      id: over.id ?? 'm1',
      type: 'custom_text',
      from_field: { id: 'self' },
      to_fields: [{ id: '+1555' }],
      references: [],
      ...(over.text !== undefined ? { body: over.text } : {}),
      ...(over.attachments !== undefined ? { attachments: over.attachments } : {}),
    },
    conversation: { id: over.conversationId ?? 'conv-default' },
  };
}

function bbSendJob(hook: MissiveOutboundWebhook, chatGuid: string | null): OutboxRow {
  return {
    id: 1,
    kind: 'bb_send',
    chat_guid: chatGuid,
    payload: hook,
    attempts: 0,
    next_at: 0,
    status: 'pending',
    last_error: null,
    created_at: 0,
  };
}

function missiveJob(evt: BbWebhook, chatGuid: string | null = null): OutboxRow {
  return {
    id: 2,
    kind: 'missive_post',
    chat_guid: chatGuid,
    payload: evt,
    attempts: 0,
    next_at: 0,
    status: 'pending',
    last_error: null,
    created_at: 0,
  };
}

function missiveBody(over: Partial<MissiveInboundMessage> = {}): MissiveInboundBody {
  return {
    messages: {
      account: 'acct-test',
      from_field: { id: '+1555' },
      to_fields: [{ id: '+self' }],
      references: ['bb-chat-C1'],
      ...over,
    },
  };
}

/** A planOutbound impl that exercises every OutboundCtx closure, then returns `plan`. */
function planOutboundPoking(plan: SendPlan) {
  return (_hook: MissiveOutboundWebhook, ctx: OutboundCtx): SendPlan => {
    ctx.newTempGuid();
    ctx.getChatGuidByConversation('conv-x');
    ctx.resolveChatByReference('bb-chat-POKE');
    ctx.resolveChatByReference('not-a-reference');
    ctx.resolveDmChatGuid('+1999');
    return plan;
  };
}

/** A planInbound impl that exercises every InboundCtx closure, then returns `posts`. */
function planInboundPoking(posts: InboundPost[]) {
  return (_evt: BbWebhook, ctx: InboundCtx): InboundPost[] => {
    ctx.lookupChatForMessage('poke');
    ctx.getMessageText('poke');
    ctx.resolveName('+1poke');
    ctx.getConversationId('poke-chat');
    return posts;
  };
}

const newMessage = (data: Partial<BbMessage> & { guid: string }): BbWebhook => ({
  type: 'new-message',
  data: { text: null, handle: null, isFromMe: false, ...data },
});

async function waitUntil(pred: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  spyOn(capability, 'getCaps').mockReturnValue({
    privateApi: false,
    helperConnected: false,
    lastProbeAt: 0,
  });
});

afterEach(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// bb_send dispatch
// ---------------------------------------------------------------------------

describe('dispatch — bb_send', () => {
  it('message/text: records the send, binds the conversation, stores the bb_guid', async () => {
    const db = freshDb();
    db.mapChat('C', 'bb-chat-C'); // exists, no conversation bound yet
    const plan: SendPlan = {
      resolution: 'reply-known-chat',
      send: { op: 'message/text', chatGuid: 'C' },
      tempGuid: 't-text',
      text: 'hello there',
      missiveMsgId: 'm-text',
    };
    spyOn(outboundDomain, 'planOutbound').mockImplementation(planOutboundPoking(plan));
    const sendText = spyOn(bbClient, 'sendText').mockResolvedValue({
      guid: 'BB-TEXT',
    } as BbMessage);

    const hook = makeHook({ id: 'm-text', text: 'hello there', conversationId: 'conv-text' });
    await dispatch(bbSendJob(hook, 'C'), makeDeps(db, { fetch }));

    const rec = db.getSendByMissiveId('m-text');
    expect(rec?.temp_guid).toBe('t-text');
    expect(rec?.chat_guid).toBe('C');
    expect(rec?.text).toBe('hello there');
    expect(db.findEchoByBbGuid('BB-TEXT')?.temp_guid).toBe('t-text');
    expect(db.getChatByGuid('C')?.conversation_id).toBe('conv-text'); // bound (invariant #6)

    const args = sendText.mock.calls[0]?.[0];
    expect(args?.method).toBe('apple-script');
    expect(args?.tempGuid).toBe('t-text');
    expect(args?.message).toBe('hello there');
  });

  it('on retry: reuses the recorded tempGuid, does not re-record, and skips an already-bound chat', async () => {
    const db = freshDb();
    db.mapChat('C', 'bb-chat-C', 'conv-pre'); // already bound -> bind branch skipped
    db.recordSend({ tempGuid: 't-existing', chatGuid: 'C', missiveMsgId: 'm-retry', text: 'hi' });
    const plan: SendPlan = {
      resolution: 'reply-known-chat',
      send: { op: 'message/text', chatGuid: 'C' },
      tempGuid: 't-existing',
      text: 'hi',
      missiveMsgId: 'm-retry',
    };
    spyOn(outboundDomain, 'planOutbound').mockReturnValue(plan);
    spyOn(bbClient, 'sendText').mockResolvedValue({ guid: 'BB-R' } as BbMessage);

    const countBefore = (db.raw.query('SELECT COUNT(*) AS n FROM sent_map').get() as { n: number })
      .n;
    await dispatch(
      bbSendJob(makeHook({ id: 'm-retry', text: 'hi', conversationId: 'conv-pre' }), 'C'),
      makeDeps(db),
    );
    const countAfter = (db.raw.query('SELECT COUNT(*) AS n FROM sent_map').get() as { n: number })
      .n;

    expect(countAfter).toBe(countBefore); // no duplicate row
    expect(db.getSendByMissiveId('m-retry')?.bb_guid).toBe('BB-R');
    expect(db.getChatByGuid('C')?.conversation_id).toBe('conv-pre'); // unchanged
  });

  it('message/attachment: sends a multipart form with inline bytes and stores the bb_guid', async () => {
    const db = freshDb();
    const plan: SendPlan = {
      resolution: 'reply-known-chat',
      send: { op: 'message/attachment', chatGuid: 'C' },
      tempGuid: 't-att',
      missiveMsgId: 'm-att',
    };
    spyOn(outboundDomain, 'planOutbound').mockReturnValue(plan);
    const sendAttachment = spyOn(bbClient, 'sendAttachment').mockResolvedValue({
      guid: 'BB-ATT',
    } as BbMessage);

    const hook = makeHook({
      id: 'm-att',
      attachments: [
        { filename: 'pic.png', media_type: 'image/png', base64_data: btoa('imagebytes') },
      ],
    });
    await dispatch(bbSendJob(hook, 'C'), makeDeps(db));

    const form = sendAttachment.mock.calls[0]?.[0] as FormData;
    expect(form.get('chatGuid')).toBe('C');
    expect(form.get('tempGuid')).toBe('t-att');
    expect(form.get('name')).toBe('pic.png');
    expect(form.get('attachment')).toBeInstanceOf(File);
    expect(db.findEchoByBbGuid('BB-ATT')?.temp_guid).toBe('t-att');
  });

  it('message/attachment: falls back to a default filename and an untyped File', async () => {
    const db = freshDb();
    const plan: SendPlan = {
      resolution: 'reply-known-chat',
      send: { op: 'message/attachment', chatGuid: 'C' },
      tempGuid: 't-att2',
      missiveMsgId: 'm-att2',
    };
    spyOn(outboundDomain, 'planOutbound').mockReturnValue(plan);
    const sendAttachment = spyOn(bbClient, 'sendAttachment').mockResolvedValue({
      guid: 'BB-ATT2',
    } as BbMessage);

    const hook = makeHook({ id: 'm-att2', attachments: [{ base64_data: btoa('x') }] });
    await dispatch(bbSendJob(hook, 'C'), makeDeps(db));

    const form = sendAttachment.mock.calls[0]?.[0] as FormData;
    expect(form.get('name')).toBe('attachment');
    const file = form.get('attachment') as File;
    expect(file.type).toBe('');
  });

  it('message/attachment: dead-letters (permanent BbError) when no inline bytes are present', async () => {
    const db = freshDb();
    const plan: SendPlan = {
      resolution: 'reply-known-chat',
      send: { op: 'message/attachment', chatGuid: 'C' },
      tempGuid: 't-att3',
      missiveMsgId: 'm-att3',
    };
    spyOn(outboundDomain, 'planOutbound').mockReturnValue(plan);

    const hook = makeHook({ id: 'm-att3', attachments: [{ filename: 'nobytes.bin' }] });
    await expect(dispatch(bbSendJob(hook, 'C'), makeDeps(db))).rejects.toMatchObject({
      name: 'BbError',
      retryable: false,
    });
  });

  it('chat/new with multiple recipients: uses private-api and maps the new chat + conversation', async () => {
    const db = freshDb();
    const plan: SendPlan = {
      resolution: 'new-conversation',
      send: { op: 'chat/new', addresses: ['+1', '+2'] },
      tempGuid: 't-new',
      text: 'first message',
      missiveMsgId: 'm-new',
    };
    spyOn(outboundDomain, 'planOutbound').mockReturnValue(plan);
    const chatNew = spyOn(bbClient, 'chatNew').mockResolvedValue({ guid: 'NEWGUID' });

    const hook = makeHook({ id: 'm-new', text: 'first message', conversationId: 'conv-new' });
    await dispatch(bbSendJob(hook, null), makeDeps(db));

    const args = chatNew.mock.calls[0]?.[0];
    expect(args?.method).toBe('private-api');
    expect(args?.addresses).toEqual(['+1', '+2']);
    expect(args?.message).toBe('first message');
    expect(args?.tempGuid).toBe('t-new');
    // Recorded pre-send with a null chat, then backfilled to the created chat
    // guid so the new conversation's own echo is suppressed (invariant #3 / #5).
    expect(db.getSendByMissiveId('m-new')?.chat_guid).toBe('NEWGUID');
    expect(db.getChatByGuid('NEWGUID')?.reference).toBe('bb-chat-NEWGUID');
    expect(db.getChatByGuid('NEWGUID')?.conversation_id).toBe('conv-new');
  });

  it('chat/new with one recipient: uses apple-script and omits an absent body', async () => {
    const db = freshDb();
    const plan: SendPlan = {
      resolution: 'new-conversation',
      send: { op: 'chat/new', addresses: ['+1'] },
      tempGuid: 't-new2',
      missiveMsgId: 'm-new2',
    };
    spyOn(outboundDomain, 'planOutbound').mockReturnValue(plan);
    const chatNew = spyOn(bbClient, 'chatNew').mockResolvedValue({ guid: 'NEWGUID2' });

    await dispatch(bbSendJob(makeHook({ id: 'm-new2' }), null), makeDeps(db));

    const args = chatNew.mock.calls[0]?.[0];
    expect(args?.method).toBe('apple-script');
    expect(args && 'message' in args).toBe(false);
    expect(args?.service).toBe('iMessage'); // no PA -> no availability probe -> default
  });
});

// ---------------------------------------------------------------------------
// bb_send dispatch — SMS availability fallback (chat/new)
// ---------------------------------------------------------------------------

describe('dispatch — chat/new SMS availability fallback', () => {
  function chatNewPlan(): SendPlan {
    return {
      resolution: 'new-conversation',
      send: { op: 'chat/new', addresses: ['+15551112222'] },
      tempGuid: 't-sms',
      text: 'hello',
      missiveMsgId: 'm-sms',
    };
  }

  it('falls back to SMS when the recipient is not iMessage-reachable (PA on)', async () => {
    const db = freshDb();
    spyOn(capability, 'getCaps').mockReturnValue({
      privateApi: true,
      helperConnected: true,
      lastProbeAt: 1,
    });
    spyOn(outboundDomain, 'planOutbound').mockReturnValue(chatNewPlan());
    const avail = spyOn(bbClient, 'handleAvailabilityImessage').mockResolvedValue(false);
    const chatNew = spyOn(bbClient, 'chatNew').mockResolvedValue({ guid: 'SMSCHAT' });

    await dispatch(bbSendJob(makeHook({ id: 'm-sms', text: 'hello' }), null), makeDeps(db));

    expect(avail).toHaveBeenCalledWith('+15551112222', expect.anything());
    expect(chatNew.mock.calls[0]?.[0]?.service).toBe('SMS');
  });

  it('keeps iMessage when the recipient is reachable (PA on)', async () => {
    const db = freshDb();
    spyOn(capability, 'getCaps').mockReturnValue({
      privateApi: true,
      helperConnected: true,
      lastProbeAt: 1,
    });
    spyOn(outboundDomain, 'planOutbound').mockReturnValue(chatNewPlan());
    spyOn(bbClient, 'handleAvailabilityImessage').mockResolvedValue(true);
    const chatNew = spyOn(bbClient, 'chatNew').mockResolvedValue({ guid: 'IMSGCHAT' });

    await dispatch(bbSendJob(makeHook({ id: 'm-sms', text: 'hello' }), null), makeDeps(db));
    expect(chatNew.mock.calls[0]?.[0]?.service).toBe('iMessage');
  });

  it('keeps the default service when the availability probe throws (PA on)', async () => {
    const db = freshDb();
    spyOn(capability, 'getCaps').mockReturnValue({
      privateApi: true,
      helperConnected: true,
      lastProbeAt: 1,
    });
    spyOn(outboundDomain, 'planOutbound').mockReturnValue(chatNewPlan());
    spyOn(bbClient, 'handleAvailabilityImessage').mockRejectedValue(new Error('no PA route'));
    const chatNew = spyOn(bbClient, 'chatNew').mockResolvedValue({ guid: 'DEFCHAT' });

    await dispatch(bbSendJob(makeHook({ id: 'm-sms', text: 'hello' }), null), makeDeps(db));
    expect(chatNew.mock.calls[0]?.[0]?.service).toBe('iMessage');
  });
});

// ---------------------------------------------------------------------------
// bb_send dispatch — attachments (multipart vs apple-script, caption/multi)
// ---------------------------------------------------------------------------

describe('dispatch — attachment sends', () => {
  function attachmentPlan(tempGuid = 't-att', missiveMsgId = 'm-att'): SendPlan {
    return {
      resolution: 'reply-known-chat',
      send: { op: 'message/attachment', chatGuid: 'C' },
      tempGuid,
      missiveMsgId,
    };
  }

  it('Private API + caption: uploads each file and sends ONE multipart (full fidelity)', async () => {
    const db = freshDb();
    spyOn(capability, 'getCaps').mockReturnValue({
      privateApi: true,
      helperConnected: true,
      lastProbeAt: 1,
    });
    spyOn(outboundDomain, 'planOutbound').mockReturnValue(attachmentPlan('t-mp', 'm-mp'));
    const upload = spyOn(bbClient, 'uploadAttachment').mockResolvedValue({ guid: 'up-1' });
    const multipart = spyOn(bbClient, 'sendMultipart').mockResolvedValue({
      guid: 'BB-MP',
    } as BbMessage);
    const sendAttachment = spyOn(bbClient, 'sendAttachment');

    const hook = makeHook({
      id: 'm-mp',
      text: 'caption!',
      attachments: [{ filename: 'pic.png', media_type: 'image/png', base64_data: btoa('img') }],
    });
    await dispatch(bbSendJob(hook, 'C'), makeDeps(db));

    expect(sendAttachment).not.toHaveBeenCalled(); // multipart, not apple-script
    expect(upload.mock.calls).toHaveLength(1);
    expect(multipart.mock.calls[0]?.[0]?.parts).toEqual([
      { type: 'text', text: 'caption!' },
      { type: 'attachment', guid: 'up-1' },
    ]);
    const rec = db.getSendByMissiveId('m-mp');
    expect(rec?.att_sig).toBe('att:1');
    expect(rec?.text).toBe('caption!');
    expect(db.findEchoByBbGuid('BB-MP')?.temp_guid).toBe('t-mp');
  });

  it('Private API + multiple files (no caption): one multipart signed att:2', async () => {
    const db = freshDb();
    spyOn(capability, 'getCaps').mockReturnValue({
      privateApi: true,
      helperConnected: true,
      lastProbeAt: 1,
    });
    spyOn(outboundDomain, 'planOutbound').mockReturnValue(attachmentPlan('t-mp2', 'm-mp2'));
    spyOn(bbClient, 'uploadAttachment').mockResolvedValue({ guid: 'up-x' });
    const multipart = spyOn(bbClient, 'sendMultipart').mockResolvedValue({
      guid: 'BB-MP2',
    } as BbMessage);

    const hook = makeHook({
      id: 'm-mp2',
      attachments: [
        { filename: 'a.png', base64_data: btoa('a') },
        { filename: 'b.png', base64_data: btoa('b') },
      ],
    });
    await dispatch(bbSendJob(hook, 'C'), makeDeps(db));

    expect(multipart.mock.calls[0]?.[0]?.parts).toEqual([
      { type: 'attachment', guid: 'up-x' },
      { type: 'attachment', guid: 'up-x' },
    ]);
    expect(db.getSendByMissiveId('m-mp2')?.att_sig).toBe('att:2');
  });

  it('no Private API + caption: sends the attachment then a recorded text follow-up', async () => {
    const db = freshDb(); // beforeEach -> privateApi:false
    spyOn(outboundDomain, 'planOutbound').mockReturnValue(attachmentPlan('t-cap', 'm-cap'));
    const sendAttachment = spyOn(bbClient, 'sendAttachment').mockResolvedValue({
      guid: 'BB-A',
    } as BbMessage);
    const sendText = spyOn(bbClient, 'sendText').mockResolvedValue({ guid: 'BB-CAP' } as BbMessage);

    const hook = makeHook({
      id: 'm-cap',
      text: 'a caption',
      attachments: [{ filename: 'pic.png', base64_data: btoa('img') }],
    });
    await dispatch(bbSendJob(hook, 'C'), makeDeps(db));

    expect(sendAttachment.mock.calls).toHaveLength(1);
    const cap = sendText.mock.calls[0]?.[0];
    expect(cap?.message).toBe('a caption');
    expect(cap?.tempGuid).toBe('t-cap:cap');
    // The caption is recorded so its own echo is suppressed by text match.
    const capRow = db.findEchoByBbGuid('BB-CAP');
    expect(capRow?.text).toBe('a caption');
    expect(capRow?.att_sig).toBeNull();
    // Primary attachment row carries att:1.
    expect(db.getSendByMissiveId('m-cap')?.att_sig).toBe('att:1');
  });

  it('no Private API + multiple files: each file is its own recorded apple-script send', async () => {
    const db = freshDb();
    spyOn(outboundDomain, 'planOutbound').mockReturnValue(attachmentPlan('t-multi', 'm-multi'));
    const sendAttachment = spyOn(bbClient, 'sendAttachment').mockResolvedValue({
      guid: 'BB-X',
    } as BbMessage);

    const hook = makeHook({
      id: 'm-multi',
      attachments: [
        { filename: 'a.png', base64_data: btoa('a') },
        { filename: 'b.png', base64_data: btoa('b') },
      ],
    });
    await dispatch(bbSendJob(hook, 'C'), makeDeps(db));

    expect(sendAttachment.mock.calls).toHaveLength(2);
    expect(sendAttachment.mock.calls[1]?.[0].get('tempGuid')).toBe('t-multi:att1');
    const rowCount = (db.raw.query('SELECT COUNT(*) AS n FROM sent_map').get() as { n: number }).n;
    expect(rowCount).toBe(2); // primary + one extra
  });

  it('on retry: re-derives the same tempGuids and re-sends without re-recording', async () => {
    const db = freshDb();
    // Pre-existing primary record simulates a prior attempt (retry path).
    db.recordSend({
      tempGuid: 't-retry',
      chatGuid: 'C',
      missiveMsgId: 'm-retry',
      text: null,
      attSig: 'att:1',
    });
    spyOn(outboundDomain, 'planOutbound').mockReturnValue(attachmentPlan('t-retry', 'm-retry'));
    spyOn(bbClient, 'sendAttachment').mockResolvedValue({ guid: 'BB-R' } as BbMessage);

    const before = (db.raw.query('SELECT COUNT(*) AS n FROM sent_map').get() as { n: number }).n;
    const hook = makeHook({
      id: 'm-retry',
      attachments: [{ filename: 'p.png', base64_data: btoa('x') }],
    });
    await dispatch(bbSendJob(hook, 'C'), makeDeps(db));
    const after = (db.raw.query('SELECT COUNT(*) AS n FROM sent_map').get() as { n: number }).n;

    expect(after).toBe(before); // no duplicate record on retry
    expect(db.getSendByMissiveId('m-retry')?.bb_guid).toBe('BB-R');
  });
});

// ---------------------------------------------------------------------------
// missive_post dispatch
// ---------------------------------------------------------------------------

describe('dispatch — missive_post', () => {
  it('posts a genuine inbound message, caches it, and registers the chat', async () => {
    const db = freshDb();
    const post: InboundPost = { body: missiveBody({ external_id: 'bb-msg-g1' }) };
    spyOn(inboundDomain, 'planInbound').mockImplementation(planInboundPoking([post]));
    const postInbound = spyOn(missiveClient, 'postInboundMessage').mockResolvedValue();

    const evt = newMessage({ guid: 'g1', text: 'hey there', chats: [{ guid: 'C1' }] });
    await dispatch(missiveJob(evt, 'C1'), makeDeps(db, { fetch }));

    expect(db.lookupChatForMessage('g1')).toBe('C1');
    expect(db.getMessageText('g1')).toBe('hey there');
    expect(db.getChatByGuid('C1')?.reference).toBe('bb-chat-C1');
    expect(postInbound.mock.calls).toHaveLength(1);
    expect((postInbound.mock.calls[0]?.[0] as MissiveInboundBody).messages.external_id).toBe(
      'bb-msg-g1',
    );
  });

  it('drops a self-echo (consume-on-match) and never posts', async () => {
    const db = freshDb();
    db.recordSend({ tempGuid: 'te', chatGuid: 'C1', missiveMsgId: 'me', text: 'echoed text' });
    const postInbound = spyOn(missiveClient, 'postInboundMessage').mockResolvedValue();
    spyOn(inboundDomain, 'planInbound').mockReturnValue([]);

    const evt = newMessage({
      guid: 'g-echo',
      text: 'echoed text',
      isFromMe: true,
      chats: [{ guid: 'C1' }],
    });
    const deps = makeDeps(db);
    await dispatch(missiveJob(evt, 'C1'), deps);

    expect(postInbound.mock.calls).toHaveLength(0);
    expect(db.getSendByMissiveId('me')?.echo_consumed).toBe(1);
    expect(deps.logger.calls.some((c) => c.msg === 'echo suppressed')).toBe(true);
  });

  it('posts a self message from another device when no echo matches', async () => {
    const db = freshDb();
    const post: InboundPost = { body: missiveBody({ external_id: 'bb-msg-g-self' }) };
    spyOn(inboundDomain, 'planInbound').mockReturnValue([post]);
    const postInbound = spyOn(missiveClient, 'postInboundMessage').mockResolvedValue();

    const evt = newMessage({
      guid: 'g-self',
      text: 'sent from my ipad',
      isFromMe: true,
      chats: [{ guid: 'C1' }],
    });
    await dispatch(missiveJob(evt, 'C1'), makeDeps(db));

    expect(postInbound.mock.calls).toHaveLength(1);
  });

  it('skips caching/echo for a new-message that carries no chat', async () => {
    const db = freshDb();
    spyOn(inboundDomain, 'planInbound').mockReturnValue([]);

    const evt = newMessage({ guid: 'g-nochat', text: 'x' }); // no chats[]
    await dispatch(missiveJob(evt, null), makeDeps(db));

    expect(db.lookupChatForMessage('g-nochat')).toBeNull();
  });

  it('passes non new-message events straight to the planner', async () => {
    const db = freshDb();
    spyOn(inboundDomain, 'planInbound').mockReturnValue([]);

    const evt: BbWebhook = { type: 'updated-message', data: { guid: 'g-upd' } };
    const deps = makeDeps(db);
    await dispatch(missiveJob(evt, 'C1'), deps);

    expect(deps.logger.calls.some((c) => c.msg === 'missive_post dispatched')).toBe(true);
  });

  it('downloads and inlines attachment bytes as base64, passing through extra slots', async () => {
    const db = freshDb();
    const post: InboundPost = {
      body: missiveBody({
        attachments: [
          { filename: 'a.jpg', base64_data: '' },
          { filename: 'b.jpg', base64_data: 'already' },
        ],
      }),
      attachmentRefs: ['att-a'],
    };
    spyOn(inboundDomain, 'planInbound').mockReturnValue([post]);
    const download = spyOn(bbClient, 'downloadAttachment').mockResolvedValue(
      new Uint8Array([1, 2, 3]),
    );
    const postInbound = spyOn(missiveClient, 'postInboundMessage').mockResolvedValue();

    const evt = newMessage({ guid: 'g-att', chats: [{ guid: 'C1' }] });
    await dispatch(missiveJob(evt, 'C1'), makeDeps(db, { fetch }));

    const body = postInbound.mock.calls[0]?.[0] as MissiveInboundBody;
    expect(body.messages.attachments?.[0]?.base64_data).toBe(
      Buffer.from([1, 2, 3]).toString('base64'),
    );
    expect(body.messages.attachments?.[1]?.base64_data).toBe('already'); // i >= encoded.length
    expect(download.mock.calls[0]?.[1]).toEqual({ original: false });
  });

  it('resolves + caches the sender display name for a genuine inbound (identity)', async () => {
    const db = freshDb();
    spyOn(bbClient, 'queryHandle').mockResolvedValue({ address: '+15551110000' });
    spyOn(bbClient, 'queryContact').mockResolvedValue({ displayName: 'Carol Contact' });
    spyOn(inboundDomain, 'planInbound').mockReturnValue([]);

    const evt = newMessage({
      guid: 'g-id',
      text: 'hi',
      isFromMe: false,
      handle: { address: '+15551110000' },
      chats: [{ guid: 'C1' }],
    });
    await dispatch(missiveJob(evt, 'C1'), makeDeps(db));

    // handle_map populated so the inbound post renders the human name.
    expect(db.getHandle('+15551110000')?.name).toBe('Carol Contact');
  });

  it('suppresses an attachment echo via the attachment signature (#5)', async () => {
    const db = freshDb();
    db.recordSend({
      tempGuid: 't-att',
      chatGuid: 'C1',
      missiveMsgId: 'm-att',
      text: null,
      attSig: 'att:1',
    });
    const postInbound = spyOn(missiveClient, 'postInboundMessage').mockResolvedValue();
    spyOn(inboundDomain, 'planInbound').mockReturnValue([]);

    const evt = newMessage({
      guid: 'g-att-echo',
      text: null,
      isFromMe: true,
      chats: [{ guid: 'C1' }],
      attachments: [{ guid: 'a1', transferName: 'photo.jpg' }],
    });
    const deps = makeDeps(db);
    await dispatch(missiveJob(evt, 'C1'), deps);

    expect(postInbound.mock.calls).toHaveLength(0);
    expect(db.getSendByMissiveId('m-att')?.echo_consumed).toBe(1);
  });

  it('skips a sub-post already delivered on a prior attempt (#7)', async () => {
    const db = freshDb();
    db.markPostDelivered('bb-msg-split:att0'); // pretend att0 landed last attempt
    const posts: InboundPost[] = [
      { body: missiveBody({ external_id: 'bb-msg-split:att0' }) },
      { body: missiveBody({ external_id: 'bb-msg-split:att1' }) },
    ];
    spyOn(inboundDomain, 'planInbound').mockReturnValue(posts);
    const postInbound = spyOn(missiveClient, 'postInboundMessage').mockResolvedValue();

    const evt: BbWebhook = { type: 'updated-message', data: { guid: 'g-split' } };
    const deps = makeDeps(db);
    await dispatch(missiveJob(evt, 'C'), deps);

    // Only the unfinished sub-post is re-posted; the delivered one is skipped.
    expect(postInbound.mock.calls).toHaveLength(1);
    expect((postInbound.mock.calls[0]?.[0] as MissiveInboundBody).messages.external_id).toBe(
      'bb-msg-split:att1',
    );
    expect(db.isPostDelivered('bb-msg-split:att1')).toBe(true);
    expect(
      deps.logger.calls.some((c) => c.msg === 'sub-post already delivered; skipping on retry'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// missive_post dispatch — message-send-error + receipts
// ---------------------------------------------------------------------------

describe('dispatch — message-send-error', () => {
  it('marks the matching send failed by tempGuid and never plans', async () => {
    const db = freshDb();
    db.recordSend({ tempGuid: 't-fail', chatGuid: 'C', missiveMsgId: 'm-fail', text: 'x' });
    const planInbound = spyOn(inboundDomain, 'planInbound');

    const evt: BbWebhook = { type: 'message-send-error', data: { tempGuid: 't-fail', error: 22 } };
    const deps = makeDeps(db);
    await dispatch(missiveJob(evt, 'C'), deps);

    expect(db.getSendByMissiveId('m-fail')?.status).toBe('failed');
    expect(planInbound).not.toHaveBeenCalled();
    expect(deps.logger.calls.some((c) => c.msg === 'outbound send marked failed')).toBe(true);
  });

  it('resolves the failed send via its bb_guid', async () => {
    const db = freshDb();
    db.recordSend({ tempGuid: 't-bg', chatGuid: 'C', missiveMsgId: 'm-bg', text: 'x' });
    db.setSendBbGuid('t-bg', 'BB-ERR');

    const evt: BbWebhook = { type: 'message-send-error', data: { guid: 'BB-ERR' } };
    await dispatch(missiveJob(evt, 'C'), makeDeps(db));
    expect(db.getSendByMissiveId('m-bg')?.status).toBe('failed');
  });

  it('logs when the error carries an unknown guid', async () => {
    const db = freshDb();
    const evt: BbWebhook = { type: 'message-send-error', data: { guid: 'BB-UNKNOWN' } };
    const deps = makeDeps(db);
    await dispatch(missiveJob(evt, 'C'), deps);
    expect(
      deps.logger.calls.some((c) => c.msg === 'message-send-error with no matching send'),
    ).toBe(true);
  });

  it('logs when the error carries no identifiers', async () => {
    const db = freshDb();
    const evt: BbWebhook = { type: 'message-send-error', data: { error: 99 } };
    const deps = makeDeps(db);
    await dispatch(missiveJob(evt, 'C'), deps);
    expect(
      deps.logger.calls.some((c) => c.msg === 'message-send-error with no matching send'),
    ).toBe(true);
  });
});

describe('dispatch — receipts as posts', () => {
  it('posts a delivered/read receipt as a conversation comment when enabled', async () => {
    const db = freshDb();
    db.mapChat('C-read', 'bb-chat-C-read', 'conv-r');
    db.cacheMessage('M-read', 'C-read', 'original', false);
    const comment = spyOn(missiveClient, 'postConversationComment').mockResolvedValue();
    const planInbound = spyOn(inboundDomain, 'planInbound');

    const evt: BbWebhook = {
      type: 'updated-message',
      data: { guid: 'M-read', isDelivered: true, dateRead: 555 },
    };
    const deps = makeDeps(db, { receiptsAsPosts: true });
    await dispatch(missiveJob(evt, 'C-read'), deps);

    expect(comment.mock.calls[0]?.[0]).toEqual({ conversationId: 'conv-r', text: '✓✓ Read' });
    expect(planInbound).not.toHaveBeenCalled();
    expect(deps.logger.calls.some((c) => c.msg === 'receipt posted as comment')).toBe(true);
  });

  it('does not post a comment when receiptsAsPosts is off (falls through to planInbound)', async () => {
    const db = freshDb();
    db.mapChat('C-read', 'bb-chat-C-read', 'conv-r');
    db.cacheMessage('M-read', 'C-read', 'original', false);
    const comment = spyOn(missiveClient, 'postConversationComment').mockResolvedValue();
    spyOn(inboundDomain, 'planInbound').mockReturnValue([]);

    const evt: BbWebhook = { type: 'updated-message', data: { guid: 'M-read', dateRead: 555 } };
    await dispatch(missiveJob(evt, 'C-read'), makeDeps(db));
    expect(comment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// drainOutbox — reliability
// ---------------------------------------------------------------------------

describe('drainOutbox', () => {
  function enqueueFailing(db: Db, rejection: unknown): void {
    const evt: BbWebhook = { type: 'updated-message', data: { guid: 'g-fail' } };
    db.enqueue({ kind: 'missive_post', chat_guid: 'C', payload: evt });
    spyOn(inboundDomain, 'planInbound').mockReturnValue([{ body: missiveBody() }]);
    spyOn(missiveClient, 'postInboundMessage').mockImplementation(() => Promise.reject(rejection));
  }

  it('dispatches due jobs and marks them done', async () => {
    const db = freshDb();
    db.enqueue({
      kind: 'missive_post',
      chat_guid: 'C',
      payload: { type: 'updated-message', data: { guid: 'g-ok' } },
    });
    spyOn(inboundDomain, 'planInbound').mockReturnValue([]);
    const deps = makeDeps(db);

    expect(await drainOutbox(deps)).toBe(1);
    expect(db.claimDueJobs(db.now(), 10)).toHaveLength(0);
    expect(deps.logger.calls.some((c) => c.msg === 'drain pass complete')).toBe(true);
  });

  it('returns 0 and logs nothing extra when the outbox is empty', async () => {
    const db = freshDb();
    const deps = makeDeps(db);
    expect(await drainOutbox(deps)).toBe(0);
    expect(deps.logger.calls.some((c) => c.msg === 'drain pass complete')).toBe(false);
  });

  it('reschedules a retryable BbError (5xx) with backoff', async () => {
    const db = freshDb();
    enqueueFailing(db, new bbClient.BbError('upstream 503', true, 503));
    const deps = makeDeps(db);

    await drainOutbox(deps);
    const row = outboxRow(db);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('upstream 503');
    expect(row.next_at).toBeGreaterThanOrEqual(db.now());
    expect(deps.logger.calls.some((c) => c.msg === 'job rescheduled')).toBe(true);
  });

  it('dead-letters a permanent BbError (4xx)', async () => {
    const db = freshDb();
    enqueueFailing(db, new bbClient.BbError('bad request', false, 400));
    const deps = makeDeps(db);

    await drainOutbox(deps);
    const row = outboxRow(db);
    expect(row.status).toBe('dead');
    expect(row.last_error).toBe('bad request');
    expect(deps.logger.calls.some((c) => c.msg === 'job dead-lettered')).toBe(true);
  });

  it('honors a Missive Retry-After (429) exactly', async () => {
    const db = freshDb();
    enqueueFailing(
      db,
      new missiveClient.MissiveError('rate limited', { retryable: true, retryAfterMs: 4242 }),
    );
    const deps = makeDeps(db);

    const at = db.now();
    await drainOutbox(deps);
    const row = outboxRow(db);
    expect(row.attempts).toBe(1);
    expect(row.next_at).toBe(at + 4242);
    expect(row.status).toBe('pending');
  });

  it('reschedules a retryable MissiveError that carries no Retry-After', async () => {
    const db = freshDb();
    enqueueFailing(db, new missiveClient.MissiveError('5xx', { retryable: true }));
    const deps = makeDeps(db);

    await drainOutbox(deps);
    expect(outboxRow(db).status).toBe('pending');
    expect(outboxRow(db).attempts).toBe(1);
  });

  it('dead-letters a permanent MissiveError (4xx)', async () => {
    const db = freshDb();
    enqueueFailing(db, new missiveClient.MissiveError('forbidden', { permanent: true }));

    await drainOutbox(makeDeps(db));
    expect(outboxRow(db).status).toBe('dead');
  });

  it('treats an unknown Error as transient and reschedules', async () => {
    const db = freshDb();
    enqueueFailing(db, new Error('something weird'));

    await drainOutbox(makeDeps(db));
    const row = outboxRow(db);
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('something weird');
  });

  it('stringifies a non-Error rejection for the dead-letter reason', async () => {
    const db = freshDb();
    enqueueFailing(db, 'plain string failure');

    await drainOutbox(makeDeps(db, { maxAttempts: 1 }));
    const row = outboxRow(db);
    expect(row.status).toBe('dead'); // exhausted at maxAttempts=1
    expect(row.last_error).toBe('plain string failure');
  });

  it('dead-letters a retryable error once attempts reach maxAttempts', async () => {
    const db = freshDb();
    enqueueFailing(db, new bbClient.BbError('still 5xx', true, 503));

    await drainOutbox(makeDeps(db, { maxAttempts: 1 }));
    expect(outboxRow(db).status).toBe('dead');
  });
});

// ---------------------------------------------------------------------------
// startWorker + enqueueJob + constants
// ---------------------------------------------------------------------------

describe('startWorker', () => {
  it('polls drainOutbox on an interval and stop() halts it', async () => {
    const db = freshDb();
    const claim = spyOn(db, 'claimDueJobs');
    const worker = startWorker(makeDeps(db, { pollMs: 1 }));

    await waitUntil(() => claim.mock.calls.length >= 1);
    expect(claim.mock.calls.length).toBeGreaterThanOrEqual(1);

    await worker.stop();
    const seen = claim.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(claim.mock.calls.length).toBe(seen); // no further ticks after stop
  });

  it('logs an error when a drain pass rejects', async () => {
    const brokenDb = {
      now: () => 0,
      claimDueJobs: () => {
        throw new Error('db unavailable');
      },
    } as unknown as Db;
    const deps = makeDeps(brokenDb, { pollMs: 1 });
    const worker = startWorker(deps);

    await waitUntil(() => deps.logger.calls.some((c) => c.level === 'error'));
    expect(deps.logger.calls.some((c) => c.msg === 'drain pass failed')).toBe(true);
    await worker.stop();
  });

  it('does not start an overlapping pass while a slow drain is still in flight', async () => {
    const db = freshDb();
    db.enqueue({
      kind: 'missive_post',
      chat_guid: 'C',
      payload: { type: 'updated-message', data: { guid: 'g-slow' } },
    });
    spyOn(inboundDomain, 'planInbound').mockReturnValue([
      { body: missiveBody({ external_id: 'bb-msg-slow' }) },
    ]);
    // Block the single dispatch on a manually-released promise.
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    spyOn(missiveClient, 'postInboundMessage').mockImplementation(() => blocked);
    const claim = spyOn(db, 'claimDueJobs');

    const worker = startWorker(makeDeps(db, { pollMs: 1 }));
    // Many ticks fire (every 1ms) while the first pass is parked on the post.
    await new Promise((resolve) => setTimeout(resolve, 25));
    // The reentrancy guard let exactly ONE pass claim; the rest were skipped.
    expect(claim.mock.calls.length).toBe(1);

    release();
    await worker.stop();
  });
});

describe('enqueueJob + MAX_ATTEMPTS', () => {
  it('enqueues a durable job round-tripping the payload', () => {
    const db = freshDb();
    enqueueJob(db, 'bb_send', 'C', { hello: 'world' });
    const [row] = db.claimDueJobs(db.now(), 10);
    expect(row?.kind).toBe('bb_send');
    expect(row?.chat_guid).toBe('C');
    expect(row?.payload).toEqual({ hello: 'world' });
  });

  it('exposes the dead-letter ceiling', () => {
    expect(MAX_ATTEMPTS).toBe(8);
  });
});
