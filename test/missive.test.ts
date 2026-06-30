/**
 * Unit tests for the Missive REST client (`src/clients/missive.ts`).
 *
 * External HTTP is mocked two ways: an injected `fetch` override (deterministic,
 * inspects the outgoing request) for the bulk of cases, and a real
 * `spyOn(globalThis, 'fetch')` for the default-fetch / default-signal path. No
 * test touches the real network.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  callMissive,
  type FetchLike,
  type MissiveClientOptions,
  MissiveError,
  postConversationComment,
  postInboundMessage,
} from '../src/clients/missive.ts';
import { config } from '../src/config.ts';
import type { MissiveInboundBody } from '../src/types.ts';

/** A captured outgoing request. */
interface Captured {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Build an injectable `fetch` override that records each call and returns the
 * `Response` produced by `handler`.
 */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response): {
  fetch: FetchLike;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch: fn as unknown as FetchLike, calls };
}

/** Read a header off a captured request's (Headers-shaped) init. */
function header(c: Captured, name: string): string | null {
  return new Headers(c.init?.headers).get(name);
}

/** Parse a captured request's JSON string body. */
function jsonBody(c: Captured): unknown {
  return JSON.parse(c.init?.body as string);
}

const SAMPLE_BODY: MissiveInboundBody = {
  messages: {
    account: config.MISSIVE_ACCOUNT_ID,
    from_field: { id: '+15555550111', name: 'Ada' },
    to_fields: [{ id: config.SELF_HANDLE, name: 'Me' }],
    body: 'hello',
    references: ['bb-chat-CHAT1'],
    external_id: 'bb-msg-G1:text',
  },
};

describe('MissiveError', () => {
  it('defaults every flag when constructed with no options', () => {
    const e = new MissiveError('boom');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('MissiveError');
    expect(e.message).toBe('boom');
    expect(e.retryable).toBe(false);
    expect(e.permanent).toBe(false);
    expect(e.retryAfterMs).toBeUndefined();
    expect(e.status).toBeUndefined();
  });

  it('carries supplied options verbatim', () => {
    const e = new MissiveError('x', {
      retryable: true,
      permanent: false,
      retryAfterMs: 1234,
      status: 429,
    });
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBe(1234);
    expect(e.status).toBe(429);
  });
});

describe('callMissive — success', () => {
  it('targets the versioned base URL and forces the Bearer header', async () => {
    const { fetch, calls } = stubFetch(() => new Response('{}', { status: 200 }));
    const res = await callMissive('/messages', { method: 'POST' }, { fetch });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://public.missiveapp.com/v1/messages');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(header(calls[0] as Captured, 'authorization')).toBe(`Bearer ${config.MISSIVE_TOKEN}`);
  });

  it('preserves caller headers but always overrides Authorization', async () => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 201 }));
    await callMissive(
      '/messages',
      { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' } },
      { fetch },
    );
    expect(header(calls[0] as Captured, 'content-type')).toBe('application/json');
    expect(header(calls[0] as Captured, 'authorization')).toBe(`Bearer ${config.MISSIVE_TOKEN}`);
  });

  it('resolves on a bare 201 with no body', async () => {
    const { fetch } = stubFetch(() => new Response(null, { status: 201 }));
    const res = await callMissive('/messages', undefined, { fetch });
    expect(res.status).toBe(201);
  });

  it('passes a provided abort signal straight through', async () => {
    const ctrl = new AbortController();
    const { fetch, calls } = stubFetch(() => new Response('{}', { status: 200 }));
    await callMissive('/messages', undefined, { fetch, signal: ctrl.signal });
    expect(calls[0]?.init?.signal).toBe(ctrl.signal);
  });

  it('falls back to an internal timeout signal when none is provided', async () => {
    const { fetch, calls } = stubFetch(() => new Response('{}', { status: 200 }));
    await callMissive('/messages', undefined, { fetch });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('callMissive — 429 Retry-After parsing', () => {
  async function expect429(retryAfter: string | null): Promise<MissiveError> {
    const { fetch } = stubFetch(
      () =>
        new Response('rate limited', {
          status: 429,
          headers: retryAfter === null ? {} : { 'Retry-After': retryAfter },
        }),
    );
    try {
      await callMissive('/messages', undefined, { fetch });
      throw new Error('expected callMissive to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MissiveError);
      return err as MissiveError;
    }
  }

  it('parses an integer seconds value into milliseconds', async () => {
    const e = await expect429('30');
    expect(e.status).toBe(429);
    expect(e.retryable).toBe(true);
    expect(e.permanent).toBe(false);
    expect(e.retryAfterMs).toBe(30_000);
  });

  it('parses a future HTTP-date into a positive delay', async () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const e = await expect429(future);
    expect(e.retryAfterMs).toBeGreaterThan(0);
    expect(e.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('clamps a past HTTP-date to zero', async () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    const e = await expect429(past);
    expect(e.retryAfterMs).toBe(0);
  });

  it('yields undefined for an unparseable Retry-After', async () => {
    const e = await expect429('whenever');
    expect(e.retryAfterMs).toBeUndefined();
  });

  it('yields undefined when Retry-After is absent', async () => {
    const e = await expect429(null);
    expect(e.retryAfterMs).toBeUndefined();
  });
});

describe('callMissive — error classification', () => {
  async function statusError(status: number): Promise<MissiveError> {
    const { fetch } = stubFetch(() => new Response('err', { status }));
    try {
      await callMissive('/messages', undefined, { fetch });
      throw new Error('expected callMissive to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MissiveError);
      return err as MissiveError;
    }
  }

  it('marks 5xx as retryable', async () => {
    for (const s of [500, 503]) {
      const e = await statusError(s);
      expect(e.retryable).toBe(true);
      expect(e.permanent).toBe(false);
      expect(e.status).toBe(s);
    }
  });

  it('marks 4xx (except 429) as permanent', async () => {
    for (const s of [400, 401, 404, 422]) {
      const e = await statusError(s);
      expect(e.permanent).toBe(true);
      expect(e.retryable).toBe(false);
      expect(e.status).toBe(s);
    }
  });

  it('wraps a network/fetch rejection as retryable', async () => {
    const boom: FetchLike = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as FetchLike;
    let caught: MissiveError | undefined;
    try {
      await callMissive('/messages', undefined, { fetch: boom });
    } catch (err) {
      caught = err as MissiveError;
    }
    expect(caught).toBeInstanceOf(MissiveError);
    expect(caught?.retryable).toBe(true);
    expect(caught?.permanent).toBe(false);
    expect(caught?.status).toBeUndefined();
    expect(caught?.message).toContain('ECONNREFUSED');
  });
});

describe('postInboundMessage', () => {
  it('POSTs the wrapped body as JSON to /messages', async () => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 201 }));
    await postInboundMessage(SAMPLE_BODY, { fetch });
    expect(calls[0]?.url).toBe('https://public.missiveapp.com/v1/messages');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(header(calls[0] as Captured, 'content-type')).toBe('application/json');
    expect(jsonBody(calls[0] as Captured)).toEqual(SAMPLE_BODY);
  });

  it('tolerates an empty 201 success (resolves void)', async () => {
    const { fetch } = stubFetch(() => new Response(null, { status: 201 }));
    await expect(postInboundMessage(SAMPLE_BODY, { fetch })).resolves.toBeUndefined();
  });

  it('propagates a MissiveError on failure', async () => {
    const { fetch } = stubFetch(() => new Response('nope', { status: 500 }));
    await expect(postInboundMessage(SAMPLE_BODY, { fetch })).rejects.toBeInstanceOf(MissiveError);
  });
});

describe('postConversationComment', () => {
  it('POSTs a Posts-API payload appended to the conversation', async () => {
    const { fetch, calls } = stubFetch(() => new Response('{}', { status: 200 }));
    await postConversationComment({ conversationId: 'conv-42', text: 'Read' }, { fetch });
    expect(calls[0]?.url).toBe('https://public.missiveapp.com/v1/posts');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(header(calls[0] as Captured, 'content-type')).toBe('application/json');
    expect(jsonBody(calls[0] as Captured)).toEqual({
      posts: {
        username: config.SELF_NAME,
        conversation: 'conv-42',
        text: 'Read',
        notification: { title: config.SELF_NAME, body: 'Read' },
      },
    });
  });

  it('propagates a MissiveError on failure', async () => {
    const { fetch } = stubFetch(() => new Response('bad', { status: 400 }));
    await expect(
      postConversationComment({ conversationId: 'c', text: 't' }, { fetch }),
    ).rejects.toBeInstanceOf(MissiveError);
  });
});

describe('default fetch / signal path (no opts)', () => {
  afterEach(() => {
    spyOn(globalThis, 'fetch').mockRestore();
  });

  it('uses the global fetch and an internal timeout signal when opts is omitted', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    await postInboundMessage(SAMPLE_BODY);
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://public.missiveapp.com/v1/messages');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${config.MISSIVE_TOKEN}`);
  });
});

// Touch the re-exported option type so it is referenced (type-only).
const _optsTypeProbe: MissiveClientOptions = {};
void _optsTypeProbe;
