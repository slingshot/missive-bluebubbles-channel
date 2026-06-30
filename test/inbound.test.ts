import { describe, expect, it } from 'bun:test';
import {
  type InboundCtx,
  planInbound,
  planReceiptComment,
  TAPBACK_VERBS,
} from '../src/domain/inbound.ts';
import type { BbWebhook } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an InboundCtx with sane defaults; override per test. */
function makeCtx(over: Partial<InboundCtx> = {}): InboundCtx {
  return {
    accountId: 'acct-1',
    selfHandle: '+15555550100',
    selfName: 'Me',
    maxPayloadBytes: 9_500_000,
    receiptsAsPosts: false,
    caps: { privateApi: false, lastProbeAt: 0 },
    lookupChatForMessage: () => null,
    getMessageText: () => null,
    resolveName: (a) => `Name(${a})`,
    getConversationId: () => null,
    ...over,
  };
}

/** Build a BlueBubbles webhook envelope. */
function webhook(type: string, data: unknown): BbWebhook {
  return { type, data };
}

// ---------------------------------------------------------------------------
// new-message — plain text
// ---------------------------------------------------------------------------

describe('planInbound · new-message text', () => {
  it('maps a text message from a contact into a single Missive post', () => {
    const ctx = makeCtx();
    const posts = planInbound(
      webhook('new-message', {
        guid: 'G1',
        text: 'hello there',
        isFromMe: false,
        handle: { address: '+15551230000' },
        chats: [{ guid: 'iMessage;-;+15551230000' }],
        dateCreated: 1_700_000_000_000,
        dateDelivered: 1_700_000_001_000,
      }),
      ctx,
    );

    expect(posts).toHaveLength(1);
    const m = posts[0]!.body.messages;
    expect(m.account).toBe('acct-1');
    expect(m.body).toBe('hello there');
    expect(m.references).toEqual(['bb-chat-iMessage;-;+15551230000']);
    expect(m.external_id).toBe('bb-msg-G1');
    expect(m.from_field).toEqual({ id: '+15551230000', name: 'Name(+15551230000)' });
    expect(m.to_fields).toEqual([{ id: '+15555550100', name: 'Me' }]);
    expect(m.created_at).toBe(1_700_000_000);
    expect(m.delivered_at).toBe(1_700_000_001);
    expect(m.conversation).toBeUndefined();
    expect(m.attachments).toBeUndefined();
    expect(posts[0]!.attachmentRefs).toBeUndefined();
  });

  it('uses self as from_field when the message is from me', () => {
    const posts = planInbound(
      webhook('new-message', {
        guid: 'G2',
        text: 'sent from another device',
        isFromMe: true,
        handle: null,
        chats: [{ guid: 'C2' }],
      }),
      makeCtx(),
    );
    expect(posts[0]!.body.messages.from_field).toEqual({ id: '+15555550100', name: 'Me' });
  });

  it('falls back to the chat guid as address when the handle is missing', () => {
    const posts = planInbound(
      webhook('new-message', {
        guid: 'G3',
        text: 'no handle',
        isFromMe: false,
        handle: null,
        chats: [{ guid: 'C3' }],
      }),
      makeCtx(),
    );
    expect(posts[0]!.body.messages.from_field).toEqual({ id: 'C3', name: 'Name(C3)' });
  });

  it('binds the conversation id and subject when known', () => {
    const ctx = makeCtx({ getConversationId: () => 'conv-42' });
    const posts = planInbound(
      webhook('new-message', {
        guid: 'G4',
        text: 'group hi',
        isFromMe: false,
        handle: { address: '+1888' },
        chats: [{ guid: 'C4', displayName: 'Trip Planning', style: 1 }],
      }),
      ctx,
    );
    const m = posts[0]!.body.messages;
    expect(m.conversation).toBe('conv-42');
    expect(m.conversation_subject).toBe('Trip Planning');
  });

  it('omits timestamps when the message has none', () => {
    const posts = planInbound(
      webhook('new-message', {
        guid: 'G5',
        text: 'no dates',
        isFromMe: false,
        handle: { address: '+1' },
        chats: [{ guid: 'C5' }],
      }),
      makeCtx(),
    );
    const m = posts[0]!.body.messages;
    expect(m.created_at).toBeUndefined();
    expect(m.delivered_at).toBeUndefined();
  });

  it('drops a new-message with no routable chat guid', () => {
    expect(planInbound(webhook('new-message', { guid: 'G6', text: 'x' }), makeCtx())).toEqual([]);
  });

  it('drops an empty new-message (no text, no attachments)', () => {
    const posts = planInbound(
      webhook('new-message', {
        guid: 'G7',
        text: null,
        isFromMe: false,
        chats: [{ guid: 'C7' }],
      }),
      makeCtx(),
    );
    expect(posts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// new-message — attachments
// ---------------------------------------------------------------------------

describe('planInbound · new-message attachments', () => {
  it('packs text + a small attachment into a single post (no suffix)', () => {
    const posts = planInbound(
      webhook('new-message', {
        guid: 'A1',
        text: 'photo!',
        isFromMe: false,
        handle: { address: '+1' },
        chats: [{ guid: 'CA1' }],
        attachments: [{ guid: 'att-guid-1', transferName: 'pic.jpg', totalBytes: 1000 }],
      }),
      makeCtx(),
    );
    expect(posts).toHaveLength(1);
    const m = posts[0]!.body.messages;
    expect(m.external_id).toBe('bb-msg-A1');
    expect(m.body).toBe('photo!');
    expect(m.attachments).toEqual([{ filename: 'pic.jpg', base64_data: '' }]);
    expect(posts[0]!.attachmentRefs).toEqual(['att-guid-1']);
  });

  it('packs multiple small attachments into a single post', () => {
    const posts = planInbound(
      webhook('new-message', {
        guid: 'A2',
        text: '',
        isFromMe: false,
        handle: { address: '+1' },
        chats: [{ guid: 'CA2' }],
        attachments: [
          { guid: 'g1', transferName: 'a.jpg', totalBytes: 1000 },
          { guid: 'g2', transferName: 'b.jpg', totalBytes: 1000 },
        ],
      }),
      makeCtx(),
    );
    expect(posts).toHaveLength(1);
    const m = posts[0]!.body.messages;
    expect(m.external_id).toBe('bb-msg-A2');
    expect(m.body).toBeUndefined();
    expect(m.attachments).toHaveLength(2);
    expect(posts[0]!.attachmentRefs).toEqual(['g1', 'g2']);
  });

  it('splits text and packed attachments across posts when over the cap', () => {
    // budget = 50000 - 4096 = 45904. Two 3000-byte atts pack together (~8256);
    // the 40000-byte att is oversized -> placeholder.
    const posts = planInbound(
      webhook('new-message', {
        guid: 'A3',
        text: 'caption',
        isFromMe: false,
        handle: { address: '+1' },
        chats: [{ guid: 'CA3' }],
        attachments: [
          { guid: 'g1', transferName: 'one.jpg', totalBytes: 3000 },
          { guid: 'g2', transferName: 'two.jpg', totalBytes: 3000 },
          { guid: 'g3', transferName: 'huge.mov', totalBytes: 40_000 },
        ],
      }),
      makeCtx({ maxPayloadBytes: 50_000 }),
    );

    expect(posts).toHaveLength(3);
    const ids = posts.map((p) => p.body.messages.external_id);
    expect(ids).toEqual(['bb-msg-A3:text', 'bb-msg-A3:att0', 'bb-msg-A3:att2']);

    // text post
    expect(posts[0]!.body.messages.body).toBe('caption');
    expect(posts[0]!.body.messages.attachments).toBeUndefined();
    // packed attachment post carries both small files
    expect(posts[1]!.body.messages.attachments).toHaveLength(2);
    expect(posts[1]!.attachmentRefs).toEqual(['g1', 'g2']);
    // oversize placeholder post
    expect(posts[2]!.body.messages.body).toContain('too large to inline');
    expect(posts[2]!.body.messages.body).toContain('huge.mov');
    expect(posts[2]!.attachmentRefs).toBeUndefined();
  });

  it('puts attachments that cannot share a post into separate bins', () => {
    // budget small enough that two ~12KB atts cannot co-reside, but each fits.
    const posts = planInbound(
      webhook('new-message', {
        guid: 'A4',
        text: '',
        isFromMe: false,
        handle: { address: '+1' },
        chats: [{ guid: 'CA4' }],
        attachments: [
          { guid: 'g1', transferName: 'a.jpg', totalBytes: 9000 },
          { guid: 'g2', transferName: 'b.jpg', totalBytes: 9000 },
        ],
      }),
      // base64(9000) ~= 12000 (+128). budget = 18000 - 4096 = 13904 -> one fits,
      // two together (24256) do not. singleFits also false (sum > max).
      makeCtx({ maxPayloadBytes: 18_000 }),
    );
    expect(posts).toHaveLength(2);
    expect(posts.map((p) => p.body.messages.external_id)).toEqual([
      'bb-msg-A4:att0',
      'bb-msg-A4:att1',
    ]);
    expect(posts[0]!.attachmentRefs).toEqual(['g1']);
    expect(posts[1]!.attachmentRefs).toEqual(['g2']);
  });

  it('emits a single placeholder post for a lone oversize attachment', () => {
    const posts = planInbound(
      webhook('new-message', {
        guid: 'A5',
        text: '',
        isFromMe: false,
        handle: { address: '+1' },
        chats: [{ guid: 'CA5' }],
        attachments: [{ guid: 'g1', transferName: null, totalBytes: 40_000 }],
      }),
      makeCtx({ maxPayloadBytes: 50_000 }),
    );
    expect(posts).toHaveLength(1);
    // single post -> no suffix even though it is a placeholder
    expect(posts[0]!.body.messages.external_id).toBe('bb-msg-A5');
    // null transferName -> guid-based fallback filename
    expect(posts[0]!.body.messages.body).toContain('attachment-g1');
  });

  it('renders human-readable sizes across B/KB/MB/GB for oversize files', () => {
    const posts = planInbound(
      webhook('new-message', {
        guid: 'A6',
        text: '',
        isFromMe: false,
        handle: { address: '+1' },
        chats: [{ guid: 'CA6' }],
        attachments: [
          { guid: 'b', transferName: 'b.bin', totalBytes: 500 },
          { guid: 'k', transferName: null, totalBytes: 5_000 },
          { guid: 'm', transferName: 'm.bin', totalBytes: 5_000_000 },
          { guid: 'g', transferName: 'g.bin', totalBytes: 5_000_000_000 },
        ],
      }),
      // budget = 4100 - 4096 = 4 -> every attachment is oversize.
      makeCtx({ maxPayloadBytes: 4_100 }),
    );
    const bodies = posts.map((p) => p.body.messages.body ?? '');
    expect(bodies[0]).toContain('500 B');
    expect(bodies[1]).toContain('4.9 KB');
    expect(bodies[1]).toContain('attachment-k');
    expect(bodies[2]).toContain('4.8 MB');
    expect(bodies[3]).toContain('4.7 GB');
    expect(posts.map((p) => p.body.messages.external_id)).toEqual([
      'bb-msg-A6:att0',
      'bb-msg-A6:att1',
      'bb-msg-A6:att2',
      'bb-msg-A6:att3',
    ]);
  });
});

// ---------------------------------------------------------------------------
// new-message — tapbacks
// ---------------------------------------------------------------------------

describe('planInbound · tapbacks', () => {
  it('renders a like reaction quoting the target message', () => {
    const ctx = makeCtx({ getMessageText: () => 'see you tomorrow' });
    const posts = planInbound(
      webhook('new-message', {
        guid: 'T1',
        text: 'Liked "see you tomorrow"',
        isFromMe: false,
        handle: { address: '+1777' },
        chats: [{ guid: 'CT1' }],
        associatedMessageGuid: 'TARGET',
        associatedMessageType: 2001,
        dateCreated: 1_700_000_000_000,
      }),
      ctx,
    );
    expect(posts).toHaveLength(1);
    const m = posts[0]!.body.messages;
    expect(m.body).toBe('Name(+1777) liked "see you tomorrow"');
    expect(m.external_id).toBe('bb-msg-T1');
    expect(m.created_at).toBe(1_700_000_000);
  });

  it('renders a self reaction with a generic target when text is unknown', () => {
    const posts = planInbound(
      webhook('new-message', {
        guid: 'T2',
        text: '',
        isFromMe: true,
        handle: null,
        chats: [{ guid: 'CT2' }],
        associatedMessageType: 2000,
      }),
      makeCtx(),
    );
    expect(posts[0]!.body.messages.body).toBe('Me loved a message');
  });

  it('truncates a very long target snippet', () => {
    const long = 'x'.repeat(200);
    const ctx = makeCtx({ getMessageText: () => long });
    const posts = planInbound(
      webhook('new-message', {
        guid: 'T3',
        isFromMe: false,
        text: '',
        handle: { address: '+1' },
        chats: [{ guid: 'CT3' }],
        associatedMessageGuid: 'TARGET',
        associatedMessageType: 2003,
      }),
      ctx,
    );
    const body = posts[0]!.body.messages.body!;
    expect(body).toContain('laughed at');
    expect(body).toContain('…');
    expect(body.length).toBeLessThan(long.length + 40);
  });

  it('drops a reaction with an unknown association type', () => {
    const posts = planInbound(
      webhook('new-message', {
        guid: 'T4',
        isFromMe: false,
        text: '',
        handle: { address: '+1' },
        chats: [{ guid: 'CT4' }],
        associatedMessageType: 9999,
      }),
      makeCtx(),
    );
    expect(posts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// updated-message — edit / unsend / receipts
// ---------------------------------------------------------------------------

describe('planInbound · updated-message', () => {
  it('renders an edit with the new text', () => {
    const ctx = makeCtx({ lookupChatForMessage: () => 'CE1' });
    const posts = planInbound(
      webhook('updated-message', {
        guid: 'E1',
        text: 'fixed typo',
        isFromMe: false,
        handle: { address: '+1' },
        dateEdited: 1_700_000_500_000,
      }),
      ctx,
    );
    expect(posts).toHaveLength(1);
    const m = posts[0]!.body.messages;
    expect(m.body).toBe('✏️ Edited: fixed typo');
    expect(m.external_id).toBe('bb-msg-E1:edit1700000500000');
    expect(m.references).toEqual(['bb-chat-CE1']);
  });

  it('renders an edit with no resulting text', () => {
    const ctx = makeCtx({ lookupChatForMessage: () => 'CE2' });
    const posts = planInbound(
      webhook('updated-message', {
        guid: 'E2',
        text: null,
        isFromMe: true,
        dateEdited: 1_700_000_600_000,
      }),
      ctx,
    );
    expect(posts[0]!.body.messages.body).toBe('✏️ Edited the message');
  });

  it('renders an unsend quoting the original message', () => {
    const original = 'a'.repeat(200);
    const ctx = makeCtx({
      lookupChatForMessage: () => 'CU1',
      getMessageText: () => original,
    });
    const posts = planInbound(
      webhook('updated-message', {
        guid: 'U1',
        text: null,
        isFromMe: false,
        handle: { address: '+1' },
        dateRetracted: 1_700_000_700_000,
      }),
      ctx,
    );
    const m = posts[0]!.body.messages;
    expect(m.body).toContain('🚫 Unsent:');
    expect(m.body).toContain('…');
    expect(m.external_id).toBe('bb-msg-U1:unsend1700000700000');
  });

  it('renders an unsend without the original text', () => {
    const ctx = makeCtx({ lookupChatForMessage: () => 'CU2' });
    const posts = planInbound(
      webhook('updated-message', {
        guid: 'U2',
        text: null,
        isFromMe: false,
        handle: { address: '+1' },
        dateRetracted: 1_700_000_800_000,
      }),
      ctx,
    );
    expect(posts[0]!.body.messages.body).toBe('🚫 Unsent a message');
  });

  it('treats a delivered/read update as a no-op', () => {
    const ctx = makeCtx({ lookupChatForMessage: () => 'CR1' });
    const posts = planInbound(
      webhook('updated-message', { guid: 'R1', isDelivered: true, dateRead: 123 }),
      ctx,
    );
    expect(posts).toEqual([]);
  });

  it('drops an update whose chat cannot be resolved', () => {
    const posts = planInbound(webhook('updated-message', { guid: 'R2', dateEdited: 1 }), makeCtx());
    expect(posts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// group / participant events
// ---------------------------------------------------------------------------

describe('planInbound · group events', () => {
  it('renders a group rename and binds the new subject', () => {
    const posts = planInbound(
      webhook('group-name-change', {
        guid: 'GR1',
        isFromMe: false,
        handle: { address: '+1999' },
        chats: [{ guid: 'CG1' }],
        groupTitle: 'Weekend Trip',
        dateCreated: 1_700_000_000_000,
      }),
      makeCtx(),
    );
    expect(posts).toHaveLength(1);
    const m = posts[0]!.body.messages;
    expect(m.body).toBe('Name(+1999) named the conversation "Weekend Trip"');
    expect(m.conversation_subject).toBe('Weekend Trip');
    expect(m.from_field).toEqual({ id: '+15555550100', name: 'Me' });
    expect(m.external_id).toBe('bb-msg-GR1');
  });

  it('renders a group rename with an empty name and no subject', () => {
    const posts = planInbound(
      webhook('group-name-change', {
        guid: 'GR2',
        isFromMe: true,
        chats: [{ guid: 'CG2' }],
        groupTitle: null,
      }),
      makeCtx(),
    );
    const m = posts[0]!.body.messages;
    expect(m.body).toBe('Me named the conversation');
    expect(m.conversation_subject).toBeUndefined();
  });

  it('renders icon changed / removed lines', () => {
    const changed = planInbound(
      webhook('group-icon-changed', {
        guid: 'GI1',
        isFromMe: false,
        handle: { address: '+1' },
        chats: [{ guid: 'CG3' }],
      }),
      makeCtx(),
    );
    expect(changed[0]!.body.messages.body).toBe('Name(+1) changed the group photo');

    const removed = planInbound(
      webhook('group-icon-removed', {
        guid: 'GI2',
        isFromMe: false,
        handle: { address: '+1' },
        chats: [{ guid: 'CG4' }],
      }),
      makeCtx(),
    );
    expect(removed[0]!.body.messages.body).toBe('Name(+1) removed the group photo');
  });

  it('renders participant added / removed / left lines', () => {
    const base = (type: string) =>
      planInbound(
        webhook(type, {
          guid: `P-${type}`,
          isFromMe: false,
          handle: { address: '+1' },
          chats: [{ guid: 'CG5' }],
        }),
        makeCtx(),
      )[0]!.body.messages.body;

    expect(base('participant-added')).toBe('Name(+1) added someone to the conversation');
    expect(base('participant-removed')).toBe('Name(+1) removed someone from the conversation');
    expect(base('participant-left')).toBe('Name(+1) left the conversation');
  });

  it('renders a generic line for an unknown group/participant subtype', () => {
    const posts = planInbound(
      webhook('participant-renamed', {
        guid: 'PG1',
        isFromMe: false,
        handle: { address: '+1' },
        chats: [{ guid: 'CG6' }],
      }),
      makeCtx(),
    );
    expect(posts[0]!.body.messages.body).toBe('Name(+1) updated the conversation');
  });

  it('falls back to a chat-derived external_id when the event has no guid', () => {
    const posts = planInbound(
      webhook('group-name-change', {
        isFromMe: true,
        chats: [{ guid: 'CG7' }],
        groupTitle: 'No Guid',
      }),
      makeCtx(),
    );
    expect(posts[0]!.body.messages.external_id).toBe('bb-grp-CG7');
  });

  it('resolves the chat via the message table when chats[] is absent', () => {
    const ctx = makeCtx({ lookupChatForMessage: () => 'CG8' });
    const posts = planInbound(
      webhook('group-name-change', {
        guid: 'GR9',
        isFromMe: false,
        handle: { address: '+1' },
        groupTitle: 'X',
      }),
      ctx,
    );
    expect(posts[0]!.body.messages.references).toEqual(['bb-chat-CG8']);
  });

  it('drops a group event whose chat cannot be resolved', () => {
    const posts = planInbound(
      webhook('participant-added', { guid: 'PG2', isFromMe: false }),
      makeCtx(),
    );
    expect(posts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// unknown / dropped events + null data
// ---------------------------------------------------------------------------

describe('planInbound · dropped events', () => {
  it('drops events the bridge does not surface as inbound messages', () => {
    expect(planInbound(webhook('message-send-error', { error: 22 }), makeCtx())).toEqual([]);
    expect(planInbound(webhook('typing-indicator', { display: true }), makeCtx())).toEqual([]);
    expect(planInbound(webhook('chat-read-status-changed', { read: true }), makeCtx())).toEqual([]);
  });

  it('tolerates a null data payload', () => {
    expect(planInbound(webhook('new-message', null), makeCtx())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// planReceiptComment — RECEIPTS_AS_POSTS (delivered/read -> Posts comment)
// ---------------------------------------------------------------------------

describe('planReceiptComment', () => {
  it('returns null when RECEIPTS_AS_POSTS is disabled', () => {
    const ctx = makeCtx({ getConversationId: () => 'conv-1', lookupChatForMessage: () => 'CR' });
    expect(
      planReceiptComment(webhook('chat-read-status-changed', { chatGuid: 'CR', read: true }), ctx),
    ).toBeNull();
  });

  it('renders a read comment for a bound chat-read-status-changed', () => {
    const ctx = makeCtx({
      receiptsAsPosts: true,
      getConversationId: (g) => (g === 'CR' ? 'conv-9' : null),
    });
    const comment = planReceiptComment(
      webhook('chat-read-status-changed', { chatGuid: 'CR', read: true }),
      ctx,
    );
    expect(comment).toEqual({ conversationId: 'conv-9', text: '✓✓ Read' });
  });

  it('drops a read-status with no chatGuid or no bound conversation', () => {
    const noGuid = makeCtx({ receiptsAsPosts: true });
    expect(planReceiptComment(webhook('chat-read-status-changed', {}), noGuid)).toBeNull();
    const unbound = makeCtx({ receiptsAsPosts: true, getConversationId: () => null });
    expect(
      planReceiptComment(webhook('chat-read-status-changed', { chatGuid: 'CR' }), unbound),
    ).toBeNull();
  });

  it('renders a read comment for an updated-message read receipt', () => {
    const ctx = makeCtx({
      receiptsAsPosts: true,
      lookupChatForMessage: () => 'CRM',
      getConversationId: () => 'conv-read',
    });
    const comment = planReceiptComment(
      webhook('updated-message', { guid: 'M1', isDelivered: true, dateRead: 123 }),
      ctx,
    );
    expect(comment).toEqual({ conversationId: 'conv-read', text: '✓✓ Read' });
  });

  it('renders a delivered comment for a delivered-only updated-message', () => {
    const ctx = makeCtx({
      receiptsAsPosts: true,
      lookupChatForMessage: () => 'CRM',
      getConversationId: () => 'conv-deliv',
    });
    const comment = planReceiptComment(
      webhook('updated-message', { guid: 'M2', isDelivered: true }),
      ctx,
    );
    expect(comment).toEqual({ conversationId: 'conv-deliv', text: '✓ Delivered' });
  });

  it('returns null for an edit/unsend (rendered as a message, not a receipt)', () => {
    const ctx = makeCtx({
      receiptsAsPosts: true,
      lookupChatForMessage: () => 'CRM',
      getConversationId: () => 'conv-x',
    });
    expect(
      planReceiptComment(webhook('updated-message', { guid: 'M3', dateEdited: 5 }), ctx),
    ).toBeNull();
    expect(
      planReceiptComment(webhook('updated-message', { guid: 'M4', dateRetracted: 6 }), ctx),
    ).toBeNull();
  });

  it('returns null when the updated-message chat or conversation is unknown', () => {
    const noChat = makeCtx({ receiptsAsPosts: true, lookupChatForMessage: () => null });
    expect(
      planReceiptComment(webhook('updated-message', { guid: 'M5', dateRead: 1 }), noChat),
    ).toBeNull();
    const noConv = makeCtx({
      receiptsAsPosts: true,
      lookupChatForMessage: () => 'C',
      getConversationId: () => null,
    });
    expect(
      planReceiptComment(webhook('updated-message', { guid: 'M6', dateRead: 1 }), noConv),
    ).toBeNull();
  });

  it('returns null for an updated-message that is neither delivered nor read', () => {
    const ctx = makeCtx({
      receiptsAsPosts: true,
      lookupChatForMessage: () => 'C',
      getConversationId: () => 'conv',
    });
    expect(planReceiptComment(webhook('updated-message', { guid: 'M7' }), ctx)).toBeNull();
  });

  it('returns null for an unrelated event type', () => {
    const ctx = makeCtx({ receiptsAsPosts: true });
    expect(planReceiptComment(webhook('new-message', { guid: 'N1' }), ctx)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// constant map
// ---------------------------------------------------------------------------

describe('TAPBACK_VERBS', () => {
  it('maps the full 2000-2005 / 3000-3005 range', () => {
    expect(TAPBACK_VERBS[2000]).toBe('loved');
    expect(TAPBACK_VERBS[2005]).toBe('questioned');
    expect(TAPBACK_VERBS[3000]).toBe('removed a love from');
    expect(TAPBACK_VERBS[3005]).toBe('removed a question from');
    expect(Object.keys(TAPBACK_VERBS)).toHaveLength(12);
  });
});
