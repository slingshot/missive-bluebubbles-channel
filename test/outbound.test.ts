/**
 * Unit tests for the PURE outbound planner (`src/domain/outbound.ts`).
 *
 * No network: the {@link OutboundCtx} resolvers are plain in-memory stubs.
 * Targets 100% line + function coverage of `parseChatReference` and
 * `planOutbound`, exercising every resolution-precedence branch, the single
 * send-op guarantee (invariant #3), the group/Private-API gate, and the
 * tempGuid + text handling.
 */

import { describe, expect, it } from 'bun:test';
import { type OutboundCtx, parseChatReference, planOutbound } from '../src/domain/outbound.ts';
import type {
  MissiveConversation,
  MissiveOutboundWebhook,
  MissiveOutMessage,
} from '../src/types.ts';

/** Build an {@link OutboundCtx} whose resolvers default to "nothing found". */
function makeCtx(overrides: Partial<OutboundCtx> = {}): OutboundCtx {
  let counter = 0;
  return {
    defaultService: 'iMessage',
    privateApi: false,
    newTempGuid: () => {
      counter += 1;
      return `temp-${counter}`;
    },
    getChatGuidByConversation: () => null,
    resolveChatByReference: () => null,
    resolveDmChatGuid: () => null,
    ...overrides,
  };
}

/** Build a Missive outbound webhook with sensible required defaults. */
function makeHook(
  message: Partial<MissiveOutMessage> = {},
  conversation: Partial<MissiveConversation> = {},
): MissiveOutboundWebhook {
  return {
    message: { id: 'mmsg-1', type: 'custom_text', ...message },
    conversation: { id: 'conv-1', ...conversation },
  };
}

// ---------------------------------------------------------------------------
// parseChatReference
// ---------------------------------------------------------------------------

describe('parseChatReference', () => {
  it('returns null when references is undefined', () => {
    expect(parseChatReference(undefined)).toBeNull();
  });

  it('returns null for an empty array', () => {
    expect(parseChatReference([])).toBeNull();
  });

  it('returns null when no token has the bb-chat- prefix', () => {
    expect(parseChatReference(['x', 'reply-to-123', 'bbchat-nope'])).toBeNull();
  });

  it('extracts the guid from a bb-chat-<guid> token', () => {
    expect(parseChatReference(['bb-chat-iMessage;-;+15551234'])).toBe('iMessage;-;+15551234');
  });

  it('skips an empty token and returns the first non-empty guid', () => {
    expect(parseChatReference(['bb-chat-', 'bb-chat-GUID2'])).toBe('GUID2');
  });

  it('returns the first usable token when several are present', () => {
    expect(parseChatReference(['bb-chat-A', 'bb-chat-B'])).toBe('A');
  });
});

// ---------------------------------------------------------------------------
// planOutbound — resolution precedence
// ---------------------------------------------------------------------------

describe('planOutbound resolution precedence', () => {
  it('(a) resolves a known chat by conversation.id', () => {
    const ctx = makeCtx({
      getChatGuidByConversation: (id) => (id === 'conv-1' ? 'CHAT-A' : null),
    });
    const plan = planOutbound(makeHook({ body: 'hi' }), ctx);
    expect(plan.resolution).toBe('reply-known-chat');
    expect(plan.send).toEqual({ op: 'message/text', chatGuid: 'CHAT-A' });
    expect(plan.text).toBe('hi');
    expect(plan.missiveMsgId).toBe('mmsg-1');
    expect(plan.tempGuid).toBe('temp-1');
  });

  it('(a) wins over a references token (precedence)', () => {
    const ctx = makeCtx({
      getChatGuidByConversation: () => 'CHAT-CONV',
      resolveChatByReference: () => 'CHAT-REF',
    });
    const plan = planOutbound(makeHook({ references: ['bb-chat-CHAT-REF'] }), ctx);
    expect(plan.resolution).toBe('reply-known-chat');
    expect(plan.send).toEqual({ op: 'message/text', chatGuid: 'CHAT-CONV' });
  });

  it('(b) resolves by a references token to the canonical chat guid', () => {
    const seen: string[] = [];
    const ctx = makeCtx({
      resolveChatByReference: (guid) => {
        seen.push(guid);
        return guid === 'PARSED' ? 'CANON' : null;
      },
    });
    const plan = planOutbound(makeHook({ body: 'yo', references: ['bb-chat-PARSED'] }), ctx);
    expect(seen).toEqual(['PARSED']);
    expect(plan.resolution).toBe('reply-by-reference');
    expect(plan.send).toEqual({ op: 'message/text', chatGuid: 'CANON' });
  });

  it('(b) falls through when the parsed reference does not resolve', () => {
    const ctx = makeCtx({
      resolveChatByReference: () => null,
      resolveDmChatGuid: (addr) => (addr === '+1555' ? 'DM-CHAT' : null),
    });
    const plan = planOutbound(
      makeHook({ references: ['bb-chat-STALE'], to_fields: [{ id: 'p1', username: '+1555' }] }),
      ctx,
    );
    expect(plan.resolution).toBe('reply-known-chat');
    expect(plan.send).toEqual({ op: 'message/text', chatGuid: 'DM-CHAT' });
  });

  it('(c) resolves a single recipient to an existing 1:1 chat', () => {
    const ctx = makeCtx({
      resolveDmChatGuid: (addr) => (addr === '+15550001' ? 'DM-1' : null),
    });
    const plan = planOutbound(
      makeHook({ body: 'sup', to_fields: [{ id: 'p1', username: '+15550001' }] }),
      ctx,
    );
    expect(plan.resolution).toBe('reply-known-chat');
    expect(plan.send).toEqual({ op: 'message/text', chatGuid: 'DM-1' });
  });
});

// ---------------------------------------------------------------------------
// planOutbound — new conversations
// ---------------------------------------------------------------------------

describe('planOutbound new conversations', () => {
  it('creates a 1:1 conversation when a single recipient has no existing chat', () => {
    const ctx = makeCtx(); // resolveDmChatGuid -> null
    const plan = planOutbound(
      makeHook({ body: 'first text', to_fields: [{ id: 'p1', username: '+15550002' }] }),
      ctx,
    );
    expect(plan.resolution).toBe('new-conversation');
    expect(plan.send).toEqual({ op: 'chat/new', addresses: ['+15550002'] });
    expect(plan.text).toBe('first text');
  });

  it('creates a group conversation when the Private API is available', () => {
    const ctx = makeCtx({ privateApi: true });
    const plan = planOutbound(
      makeHook({
        to_fields: [
          { id: 'p1', username: '+1555a' },
          { id: 'p2', username: '+1555b' },
        ],
      }),
      ctx,
    );
    expect(plan.resolution).toBe('new-conversation');
    expect(plan.send).toEqual({ op: 'chat/new', addresses: ['+1555a', '+1555b'] });
  });

  it('throws when a group must be created without the Private API', () => {
    const ctx = makeCtx({ privateApi: false });
    expect(() =>
      planOutbound(
        makeHook({
          to_fields: [
            { id: 'p1', username: '+1555a' },
            { id: 'p2', username: '+1555b' },
          ],
        }),
        ctx,
      ),
    ).toThrow(/group conversation requires the BlueBubbles Private API/);
  });

  it('throws when there is no recipient and no resolvable chat', () => {
    expect(() => planOutbound(makeHook({}), makeCtx())).toThrow(
      /no resolvable recipient or chat target/,
    );
  });

  it('treats to_fields with only empty addresses as no recipient', () => {
    expect(() =>
      planOutbound(makeHook({ to_fields: [{ id: '', username: '' }] }), makeCtx()),
    ).toThrow(/no resolvable recipient or chat target/);
  });
});

// ---------------------------------------------------------------------------
// planOutbound — address extraction (map/filter branches)
// ---------------------------------------------------------------------------

describe('planOutbound address extraction', () => {
  it('prefers username but falls back to id when username is absent', () => {
    const ctx = makeCtx();
    const plan = planOutbound(makeHook({ to_fields: [{ id: 'id-only-addr' }] }), ctx);
    expect(plan.send).toEqual({ op: 'chat/new', addresses: ['id-only-addr'] });
  });

  it('falls back to id when username is whitespace-only', () => {
    const ctx = makeCtx();
    const plan = planOutbound(
      makeHook({ to_fields: [{ id: 'id-fallback', username: '   ' }] }),
      ctx,
    );
    expect(plan.send).toEqual({ op: 'chat/new', addresses: ['id-fallback'] });
  });

  it('filters out fields that resolve to an empty address', () => {
    const ctx = makeCtx({ privateApi: true });
    const plan = planOutbound(
      makeHook({
        to_fields: [
          { id: 'a', username: '+1' },
          { id: '', username: '' },
          { id: 'b', username: '+2' },
        ],
      }),
      ctx,
    );
    // The empty-address field is dropped, leaving a 2-member group.
    expect(plan.send).toEqual({ op: 'chat/new', addresses: ['+1', '+2'] });
  });
});

// ---------------------------------------------------------------------------
// planOutbound — send-op selection + text/tempGuid handling
// ---------------------------------------------------------------------------

describe('planOutbound send op + payload', () => {
  it('selects message/attachment when the message carries attachments', () => {
    const ctx = makeCtx({ getChatGuidByConversation: () => 'CHAT-A' });
    const plan = planOutbound(
      makeHook({ body: 'photo', attachments: [{ filename: 'a.jpg' }] }),
      ctx,
    );
    expect(plan.send).toEqual({ op: 'message/attachment', chatGuid: 'CHAT-A' });
    expect(plan.text).toBe('photo');
  });

  it('selects message/attachment for an existing DM with attachments', () => {
    const ctx = makeCtx({ resolveDmChatGuid: () => 'DM-X' });
    const plan = planOutbound(
      makeHook({ to_fields: [{ id: 'p', username: '+1' }], attachments: [{ filename: 'a.jpg' }] }),
      ctx,
    );
    expect(plan.send).toEqual({ op: 'message/attachment', chatGuid: 'DM-X' });
  });

  it('omits text when the message body is absent', () => {
    const ctx = makeCtx({ getChatGuidByConversation: () => 'CHAT-A' });
    const plan = planOutbound(makeHook({}), ctx);
    expect(plan.text).toBeUndefined();
    expect('text' in plan).toBe(false);
  });

  it('omits text when the message body is an empty string', () => {
    const ctx = makeCtx({ getChatGuidByConversation: () => 'CHAT-A' });
    const plan = planOutbound(makeHook({ body: '' }), ctx);
    expect(plan.text).toBeUndefined();
    expect('text' in plan).toBe(false);
  });

  it('mints the tempGuid via ctx.newTempGuid', () => {
    let calls = 0;
    const ctx = makeCtx({
      getChatGuidByConversation: () => 'CHAT-A',
      newTempGuid: () => {
        calls += 1;
        return 'fixed-temp';
      },
    });
    const plan = planOutbound(makeHook({ body: 'hi' }), ctx);
    expect(plan.tempGuid).toBe('fixed-temp');
    expect(calls).toBe(1);
  });

  it('uses an existing group chat resolved by conversation.id without the Private API', () => {
    const ctx = makeCtx({
      privateApi: false,
      getChatGuidByConversation: () => 'GROUP-CHAT',
    });
    const plan = planOutbound(
      makeHook({
        body: 'hey all',
        to_fields: [
          { id: 'p1', username: '+1' },
          { id: 'p2', username: '+2' },
        ],
      }),
      ctx,
    );
    expect(plan.resolution).toBe('reply-known-chat');
    expect(plan.send).toEqual({ op: 'message/text', chatGuid: 'GROUP-CHAT' });
  });
});
