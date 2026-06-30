import { describe, expect, it, spyOn } from 'bun:test';
import {
  BbError,
  bb,
  chatNew,
  createWebhook,
  downloadAttachment,
  edit,
  type FetchLike,
  handleAvailabilityImessage,
  listWebhooks,
  ping,
  queryChats,
  queryContact,
  queryHandle,
  react,
  sendAttachment,
  sendMultipart,
  sendText,
  serverInfo,
  unsend,
  uploadAttachment,
} from '../src/clients/bluebubbles.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A recorded fetch invocation. */
interface Call {
  url: string;
  init: RequestInit;
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Build an injectable fetch that records calls and delegates to `handler`. */
function makeFetch(handler: Handler): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const i = init ?? {};
    calls.push({ url, init: i });
    return handler(url, i);
  }) as FetchLike;
  return { fetch: f, calls };
}

/** A successful BlueBubbles `{ status, message, data }` envelope response. */
function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ status, message: 'ok', data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Parse a JSON request body recorded on a call. */
function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

/** Await a promise expected to reject and return the thrown {@link BbError}. */
async function captureError(p: Promise<unknown>): Promise<BbError> {
  try {
    await p;
  } catch (e) {
    return e as BbError;
  }
  throw new Error('expected the call to reject');
}

const BASE = 'http://localhost:1234/api/v1';
const PW = 'password=test-password';

// ---------------------------------------------------------------------------
// bb() URL builder + BbError
// ---------------------------------------------------------------------------

describe('bb', () => {
  it('builds the API url with the encoded password query param', () => {
    expect(bb('/ping')).toBe(`${BASE}/ping?${PW}`);
    expect(bb('/message/text')).toBe(`${BASE}/message/text?${PW}`);
  });
});

describe('BbError', () => {
  it('carries retryable + status (status optional)', () => {
    const a = new BbError('boom', true);
    expect(a.name).toBe('BbError');
    expect(a.retryable).toBe(true);
    expect(a.status).toBeUndefined();
    const b = new BbError('nope', false, 400);
    expect(b.retryable).toBe(false);
    expect(b.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Transport: error classification, body encoding, signals, default fetch
// ---------------------------------------------------------------------------

describe('transport error classification', () => {
  it('treats a 4xx (except 429) as a permanent error', async () => {
    const { fetch } = makeFetch(() => envelope(null, 400));
    const err = await captureError(
      sendText({ chatGuid: 'C', tempGuid: 't', message: 'x' }, { fetch }),
    );
    expect(err).toBeInstanceOf(BbError);
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(400);
  });

  it('treats a 5xx as retryable', async () => {
    const { fetch } = makeFetch(() => envelope(null, 503));
    const err = await captureError(
      sendText({ chatGuid: 'C', tempGuid: 't', message: 'x' }, { fetch }),
    );
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(503);
  });

  it('treats a 429 as retryable', async () => {
    const { fetch } = makeFetch(() => envelope(null, 429));
    const err = await captureError(
      sendText({ chatGuid: 'C', tempGuid: 't', message: 'x' }, { fetch }),
    );
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(429);
  });

  it('wraps a network throw (Error) as a retryable error and ping swallows it', async () => {
    const { fetch } = makeFetch(() => {
      throw new TypeError('network down');
    });
    expect(await ping({ fetch })).toBe(false);
    const err = await captureError(
      sendText({ chatGuid: 'C', tempGuid: 't', message: 'x' }, { fetch }),
    );
    expect(err).toBeInstanceOf(BbError);
    expect(err.retryable).toBe(true);
    expect(err.status).toBeUndefined();
    expect(err.message).toContain('network down');
  });

  it('wraps a non-Error rejection via String()', async () => {
    const { fetch } = makeFetch(() => Promise.reject('weird-failure'));
    const err = await captureError(
      sendText({ chatGuid: 'C', tempGuid: 't', message: 'x' }, { fetch }),
    );
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('weird-failure');
  });

  it('honors an injected AbortSignal instead of the default timeout', async () => {
    const ctrl = new AbortController();
    const { fetch, calls } = makeFetch(() => envelope({ guid: 'X', text: 'm' }));
    await sendText({ chatGuid: 'C', tempGuid: 't', message: 'm' }, { fetch, signal: ctrl.signal });
    expect(calls[0]?.init.signal).toBe(ctrl.signal);
  });

  it('falls back to the global fetch when no override is given', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValue(envelope('pong'));
    try {
      expect(await ping()).toBe(true);
      expect(String(spy.mock.calls[0]?.[0])).toBe(bb('/ping'));
      // The default path also attaches an AbortSignal.
      const init = spy.mock.calls[0]?.[1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Send: text / attachment / chat-new
// ---------------------------------------------------------------------------

describe('sendText', () => {
  it('POSTs JSON with apple-script as the default method', async () => {
    const { fetch, calls } = makeFetch(() => envelope({ guid: 'BB1', text: 'hi' }));
    const msg = await sendText({ chatGuid: 'C', tempGuid: 't1', message: 'hi' }, { fetch });
    expect(msg.guid).toBe('BB1');
    const call = calls[0]!;
    expect(call.url).toBe(bb('/message/text'));
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(bodyOf(call)).toEqual({
      chatGuid: 'C',
      tempGuid: 't1',
      message: 'hi',
      method: 'apple-script',
    });
  });

  it('passes through an explicit private-api method', async () => {
    const { fetch, calls } = makeFetch(() => envelope({ guid: 'BB2', text: 'yo' }));
    await sendText(
      { chatGuid: 'C', tempGuid: 't2', message: 'yo', method: 'private-api' },
      { fetch },
    );
    expect(bodyOf(calls[0]!).method).toBe('private-api');
  });
});

describe('sendAttachment', () => {
  it('POSTs the FormData verbatim with no manual Content-Type', async () => {
    const form = new FormData();
    form.set('chatGuid', 'C');
    form.set('attachment', new File([new Uint8Array([1, 2])], 'pic.png', { type: 'image/png' }));
    const { fetch, calls } = makeFetch(() => envelope({ guid: 'BB3', text: null }));
    const msg = await sendAttachment(form, { fetch });
    expect(msg.guid).toBe('BB3');
    const call = calls[0]!;
    expect(call.url).toBe(bb('/message/attachment'));
    expect(call.init.method).toBe('POST');
    expect(call.init.body).toBe(form);
    expect(call.init.headers).toBeUndefined();
  });
});

describe('chatNew', () => {
  it('defaults method=apple-script and service=DEFAULT_SERVICE', async () => {
    const { fetch, calls } = makeFetch(() => envelope({ guid: 'NEWCHAT' }));
    const res = await chatNew({ addresses: ['+15551234567'] }, { fetch });
    expect(res.guid).toBe('NEWCHAT');
    expect(bodyOf(calls[0]!)).toEqual({
      addresses: ['+15551234567'],
      method: 'apple-script',
      service: 'iMessage',
    });
  });

  it('passes message/service/method/tempGuid through', async () => {
    const { fetch, calls } = makeFetch(() => envelope({ guid: 'G2' }));
    await chatNew(
      {
        addresses: ['+1', '+2'],
        message: 'hello',
        service: 'SMS',
        method: 'private-api',
        tempGuid: 'tmp',
      },
      { fetch },
    );
    expect(bodyOf(calls[0]!)).toEqual({
      addresses: ['+1', '+2'],
      message: 'hello',
      method: 'private-api',
      service: 'SMS',
      tempGuid: 'tmp',
    });
  });
});

// ---------------------------------------------------------------------------
// Query: chats / handle / contact / availability
// ---------------------------------------------------------------------------

describe('queryChats', () => {
  it('filters by the first guid when provided and returns the array', async () => {
    const chats = [{ guid: 'iMessage;-;+1' }];
    const { fetch, calls } = makeFetch(() => envelope(chats));
    const out = await queryChats({ guids: ['iMessage;-;+1'], limit: 5, offset: 2 }, { fetch });
    expect(out).toEqual(chats);
    expect(bodyOf(calls[0]!)).toEqual({ with: [], limit: 5, offset: 2, guid: 'iMessage;-;+1' });
  });

  it('omits the guid filter and tolerates a missing data field (-> [])', async () => {
    const { fetch, calls } = makeFetch(() => envelope(undefined));
    const out = await queryChats({}, { fetch });
    expect(out).toEqual([]);
    expect(bodyOf(calls[0]!)).toEqual({ with: [] });
  });

  it('treats an empty guids array as no filter', async () => {
    const { fetch, calls } = makeFetch(() => envelope([]));
    await queryChats({ guids: [] }, { fetch });
    expect(bodyOf(calls[0]!).guid).toBeUndefined();
  });
});

describe('queryHandle', () => {
  it('returns the first handle address', async () => {
    const { fetch, calls } = makeFetch(() => envelope([{ address: '+15550001111' }]));
    const out = await queryHandle('+15550001111', { fetch });
    expect(out).toEqual({ address: '+15550001111' });
    expect(calls[0]!.url).toBe(bb('/handle/query'));
    expect(bodyOf(calls[0]!)).toEqual({ address: '+15550001111' });
  });

  it('returns null for an empty result set', async () => {
    const { fetch } = makeFetch(() => envelope([]));
    expect(await queryHandle('+1', { fetch })).toBeNull();
  });

  it('returns null when the first row has no address', async () => {
    const { fetch } = makeFetch(() => envelope([{}]));
    expect(await queryHandle('+1', { fetch })).toBeNull();
  });

  it('returns null when data is absent', async () => {
    const { fetch } = makeFetch(() => envelope(undefined));
    expect(await queryHandle('+1', { fetch })).toBeNull();
  });
});

describe('queryContact', () => {
  it('returns the first display name', async () => {
    const { fetch, calls } = makeFetch(() => envelope([{ displayName: 'Alice' }]));
    expect(await queryContact('+1', { fetch })).toEqual({ displayName: 'Alice' });
    expect(bodyOf(calls[0]!)).toEqual({ addresses: ['+1'] });
  });

  it('returns an empty object when the contact exists without a name', async () => {
    const { fetch } = makeFetch(() => envelope([{ firstName: 'x' }]));
    expect(await queryContact('+1', { fetch })).toEqual({});
  });

  it('returns null when there is no contact', async () => {
    const { fetch } = makeFetch(() => envelope([]));
    expect(await queryContact('+1', { fetch })).toBeNull();
  });
});

describe('handleAvailabilityImessage', () => {
  it('appends the encoded address and reports availability', async () => {
    const { fetch, calls } = makeFetch(() => envelope({ available: true }));
    const ok = await handleAvailabilityImessage('+15555550100', { fetch });
    expect(ok).toBe(true);
    expect(calls[0]!.url).toBe(`${bb('/handle/availability/imessage')}&address=%2B15555550100`);
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('reports false when unavailable / unset', async () => {
    const { fetch } = makeFetch(() => envelope({ available: false }));
    expect(await handleAvailabilityImessage('+1', { fetch })).toBe(false);
    const { fetch: f2 } = makeFetch(() => envelope({}));
    expect(await handleAvailabilityImessage('+1', { fetch: f2 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Attachment download
// ---------------------------------------------------------------------------

describe('downloadAttachment', () => {
  it('returns raw bytes and appends original=true', async () => {
    const bytes = new Uint8Array([10, 20, 30]);
    const { fetch, calls } = makeFetch(() => new Response(bytes, { status: 200 }));
    const out = await downloadAttachment('att1', { original: true }, { fetch });
    expect([...out]).toEqual([10, 20, 30]);
    expect(calls[0]!.url).toBe(`${bb('/attachment/att1/download')}&original=true`);
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('appends original=false when requested', async () => {
    const { fetch, calls } = makeFetch(() => new Response(new Uint8Array(), { status: 200 }));
    await downloadAttachment('att2', { original: false }, { fetch });
    expect(calls[0]!.url).toBe(`${bb('/attachment/att2/download')}&original=false`);
  });

  it('omits the original param when no args are given and encodes the guid', async () => {
    const { fetch, calls } = makeFetch(() => new Response(new Uint8Array([1]), { status: 200 }));
    await downloadAttachment('a/b c', undefined, { fetch });
    expect(calls[0]!.url).toBe(bb('/attachment/a%2Fb%20c/download'));
  });
});

// ---------------------------------------------------------------------------
// Server info / ping / webhooks
// ---------------------------------------------------------------------------

describe('serverInfo', () => {
  it('coerces both capability flags to booleans', async () => {
    const { fetch } = makeFetch(() =>
      envelope({ private_api: true, helper_connected: true, os_version: '14' }),
    );
    expect(await serverInfo({ fetch })).toEqual({ private_api: true, helper_connected: true });
  });

  it('reports false for absent / falsey flags', async () => {
    const { fetch } = makeFetch(() => envelope({ private_api: false }));
    expect(await serverInfo({ fetch })).toEqual({ private_api: false, helper_connected: false });
  });
});

describe('ping', () => {
  it('resolves true on a 2xx', async () => {
    const { fetch } = makeFetch(() => envelope('pong'));
    expect(await ping({ fetch })).toBe(true);
  });

  it('resolves false on failure', async () => {
    const { fetch } = makeFetch(() => envelope(null, 500));
    expect(await ping({ fetch })).toBe(false);
  });
});

describe('listWebhooks', () => {
  it('maps registered webhook urls', async () => {
    const { fetch, calls } = makeFetch(() =>
      envelope([
        { id: 1, url: 'https://a/hook', events: ['*'] },
        { id: 2, url: 'https://b/hook', events: ['*'] },
      ]),
    );
    expect(await listWebhooks({ fetch })).toEqual([
      { url: 'https://a/hook' },
      { url: 'https://b/hook' },
    ]);
    expect(calls[0]!.url).toBe(bb('/webhook'));
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('returns an empty array when data is absent', async () => {
    const { fetch } = makeFetch(() => envelope(undefined));
    expect(await listWebhooks({ fetch })).toEqual([]);
  });
});

describe('createWebhook', () => {
  it('POSTs the url + events and resolves void', async () => {
    const { fetch, calls } = makeFetch(() => envelope({ id: 9 }));
    const result = await createWebhook(
      { url: 'https://bridge/hook', events: ['new-messages', 'updated-message'] },
      { fetch },
    );
    expect(result).toBeUndefined();
    expect(calls[0]!.url).toBe(bb('/webhook'));
    expect(bodyOf(calls[0]!)).toEqual({
      url: 'https://bridge/hook',
      events: ['new-messages', 'updated-message'],
    });
  });
});

// ---------------------------------------------------------------------------
// Private-API: react / edit / unsend / upload / multipart
// ---------------------------------------------------------------------------

describe('react', () => {
  it('POSTs the reaction with partIndex defaulting to 0', async () => {
    const { fetch, calls } = makeFetch(() => envelope({ guid: 'R1', text: null }));
    const msg = await react(
      { chatGuid: 'C', selectedMessageGuid: 'M1', reaction: 'love' },
      { fetch },
    );
    expect(msg.guid).toBe('R1');
    expect(calls[0]!.url).toBe(bb('/message/react'));
    expect(bodyOf(calls[0]!)).toEqual({
      chatGuid: 'C',
      selectedMessageGuid: 'M1',
      reaction: 'love',
      partIndex: 0,
    });
  });

  it('passes an explicit partIndex', async () => {
    const { fetch, calls } = makeFetch(() => envelope({ guid: 'R2', text: null }));
    await react(
      { chatGuid: 'C', selectedMessageGuid: 'M1', reaction: '-like', partIndex: 3 },
      { fetch },
    );
    expect(bodyOf(calls[0]!).partIndex).toBe(3);
  });
});

describe('edit', () => {
  it('defaults backwardsCompatibilityMessage to the edited text and partIndex to 0', async () => {
    const { fetch, calls } = makeFetch(() => envelope({ guid: 'E1' }));
    const result = await edit({ guid: 'iMessage;-;m1', editedMessage: 'fixed' }, { fetch });
    expect(result).toBeUndefined();
    expect(calls[0]!.url).toBe(bb('/message/iMessage%3B-%3Bm1/edit'));
    expect(bodyOf(calls[0]!)).toEqual({
      editedMessage: 'fixed',
      backwardsCompatibilityMessage: 'fixed',
      partIndex: 0,
    });
  });

  it('passes an explicit backwards-compat message + partIndex', async () => {
    const { fetch, calls } = makeFetch(() => envelope({ guid: 'E2' }));
    await edit(
      { guid: 'm2', editedMessage: 'new', backwardsCompatMessage: 'old', partIndex: 1 },
      { fetch },
    );
    expect(bodyOf(calls[0]!)).toEqual({
      editedMessage: 'new',
      backwardsCompatibilityMessage: 'old',
      partIndex: 1,
    });
  });
});

describe('unsend', () => {
  it('POSTs partIndex defaulting to 0', async () => {
    const { fetch, calls } = makeFetch(() => envelope({ guid: 'U1' }));
    const result = await unsend({ guid: 'm3' }, { fetch });
    expect(result).toBeUndefined();
    expect(calls[0]!.url).toBe(bb('/message/m3/unsend'));
    expect(bodyOf(calls[0]!)).toEqual({ partIndex: 0 });
  });

  it('passes an explicit partIndex', async () => {
    const { fetch, calls } = makeFetch(() => envelope({ guid: 'U2' }));
    await unsend({ guid: 'm4', partIndex: 2 }, { fetch });
    expect(bodyOf(calls[0]!)).toEqual({ partIndex: 2 });
  });
});

describe('uploadAttachment', () => {
  it('returns the uploaded path as the guid', async () => {
    const form = new FormData();
    form.set('attachment', new File([new Uint8Array([9])], 'a.png'));
    const { fetch, calls } = makeFetch(() => envelope({ path: 'uuid-1/a.png' }));
    expect(await uploadAttachment(form, { fetch })).toEqual({ guid: 'uuid-1/a.png' });
    expect(calls[0]!.url).toBe(bb('/attachment/upload'));
    expect(calls[0]!.init.body).toBe(form);
    expect(calls[0]!.init.headers).toBeUndefined();
  });

  it('prefers an explicit guid field when present', async () => {
    const form = new FormData();
    const { fetch } = makeFetch(() => envelope({ guid: 'real-guid', path: 'uuid/a.png' }));
    expect(await uploadAttachment(form, { fetch })).toEqual({ guid: 'real-guid' });
  });
});

describe('sendMultipart', () => {
  it('maps text + attachment parts into indexed wire parts', async () => {
    const { fetch, calls } = makeFetch(() => envelope({ guid: 'MP1', text: 'hi' }));
    const msg = await sendMultipart(
      {
        chatGuid: 'C',
        tempGuid: 'tmp',
        parts: [
          { type: 'text', text: 'caption' },
          { type: 'attachment', guid: 'uuid/a.png' },
        ],
      },
      { fetch },
    );
    expect(msg.guid).toBe('MP1');
    expect(calls[0]!.url).toBe(bb('/message/multipart'));
    expect(bodyOf(calls[0]!)).toEqual({
      chatGuid: 'C',
      tempGuid: 'tmp',
      parts: [
        { partIndex: 0, text: 'caption' },
        { partIndex: 1, attachment: 'uuid/a.png' },
      ],
    });
  });
});
