/**
 * Integration/e2e test support: real in-process mock servers for BlueBubbles and
 * Missive (stood up via `Bun.serve`), a URL-rewriting `fetch` that routes the
 * production clients' real requests to those mocks, and a small `waitFor` poller.
 *
 * These mocks speak real HTTP — the bridge's actual `clients/*` code serializes
 * bodies, signs nothing (BB) / Bearer-auths (Missive), parses the `{data}`
 * envelope, etc. — so the integration tests exercise the genuine network path
 * end to end rather than stubbing the client functions.
 *
 * This module lives under `test/` so it is excluded from coverage and is never
 * itself collected as a test file (it defines no `test()`/`it()` cases).
 */

import { createHmac } from 'node:crypto';
import { config } from '../../src/config.ts';
import type { MissiveInboundBody } from '../../src/types.ts';

/** One request observed by a mock server (body parsed best-effort). */
export interface RecordedRequest {
  /** HTTP method. */
  readonly method: string;
  /** Path relative to the server's API root (BB: `/api/v1` stripped). */
  readonly path: string;
  /** Parsed query string. */
  readonly query: Record<string, string>;
  /** Parsed JSON body, a flattened multipart form, or `undefined`. */
  readonly body: unknown;
}

// ---------------------------------------------------------------------------
// Mock BlueBubbles
// ---------------------------------------------------------------------------

/** Mutable behaviour knobs + recorded state for the mock BlueBubbles server. */
export interface MockBbState {
  /** `server/info.private_api`. */
  privateApi: boolean;
  /** `server/info.helper_connected`. */
  helperConnected: boolean;
  /** URLs registered via `POST /webhook` (also seeds `GET /webhook`). */
  webhooks: string[];
  /** Chat guid returned by `POST /chat/new`. */
  newChatGuid: string;
  /** Raw bytes returned by `GET /attachment/:guid/download`. */
  attachmentBytes: Uint8Array;
  /** Monotonic counter feeding returned message guids. */
  sendCounter: number;
  /** Display name returned by `POST /contact/query` (null = no contact name). */
  contactName: string | null;
  /** Value returned by `GET /handle/availability/imessage`. */
  imessageAvailable: boolean;
}

/** A running mock BlueBubbles server. */
export interface MockBlueBubbles {
  /** Origin (e.g. `http://localhost:53124`) the routing fetch rewrites BB calls to. */
  readonly origin: string;
  /** Every observed request, in order. */
  readonly requests: RecordedRequest[];
  /** Mutable behaviour + recorded state. */
  readonly state: MockBbState;
  /** Count requests matching a method + relative path. */
  count(method: string, path: string): number;
  /** Clear recorded requests + restore default state. */
  reset(): void;
  /** Shut the server down. */
  stop(): Promise<void>;
}

/** JSON `{status,message,data}` envelope mirroring the BlueBubbles server. */
function bbEnvelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ status, message: 'success', data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Stand up a mock BlueBubbles server on an ephemeral port. */
export function startMockBlueBubbles(): MockBlueBubbles {
  const requests: RecordedRequest[] = [];
  const defaults = (): MockBbState => ({
    privateApi: false,
    helperConnected: false,
    webhooks: [],
    newChatGuid: 'iMessage;-;mock-new-chat',
    attachmentBytes: new Uint8Array(),
    sendCounter: 0,
    contactName: null,
    imessageAvailable: true,
  });
  const state: MockBbState = defaults();

  const server = Bun.serve({
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const rel = url.pathname.replace(/^\/api\/v1/, '');
      const query = Object.fromEntries(url.searchParams.entries());
      let body: unknown;
      if (req.method === 'POST') {
        const ct = req.headers.get('content-type') ?? '';
        if (ct.includes('multipart/form-data')) {
          const form = await req.formData();
          const obj: Record<string, unknown> = {};
          for (const [k, v] of form.entries()) {
            obj[k] = v instanceof File ? { filename: v.name, size: v.size, type: v.type } : v;
          }
          body = obj;
        } else {
          const text = await req.text();
          body = text ? JSON.parse(text) : undefined;
        }
      }
      requests.push({ method: req.method, path: rel, query, body });

      if (req.method === 'GET' && rel === '/ping') return bbEnvelope({});
      if (req.method === 'GET' && rel === '/server/info') {
        return bbEnvelope({
          private_api: state.privateApi,
          helper_connected: state.helperConnected,
        });
      }
      if (req.method === 'GET' && rel === '/webhook') {
        return bbEnvelope(state.webhooks.map((u) => ({ url: u })));
      }
      if (req.method === 'POST' && rel === '/webhook') {
        const u = (body as { url?: string } | undefined)?.url;
        if (u) state.webhooks.push(u);
        return bbEnvelope({});
      }
      if (req.method === 'POST' && rel === '/message/text') {
        state.sendCounter += 1;
        return bbEnvelope({ guid: `bb-text-${state.sendCounter}` });
      }
      if (req.method === 'POST' && rel === '/message/attachment') {
        state.sendCounter += 1;
        return bbEnvelope({ guid: `bb-att-${state.sendCounter}` });
      }
      if (req.method === 'POST' && rel === '/chat/new') {
        return bbEnvelope({ guid: state.newChatGuid });
      }
      if (req.method === 'POST' && rel === '/message/multipart') {
        state.sendCounter += 1;
        return bbEnvelope({ guid: `bb-mp-${state.sendCounter}` });
      }
      if (req.method === 'POST' && rel === '/attachment/upload') {
        state.sendCounter += 1;
        return bbEnvelope({ guid: `upload-${state.sendCounter}` });
      }
      if (req.method === 'POST' && rel === '/handle/query') {
        const addr = (body as { address?: string } | undefined)?.address;
        return bbEnvelope(addr ? [{ address: addr }] : []);
      }
      if (req.method === 'POST' && rel === '/contact/query') {
        return bbEnvelope(state.contactName != null ? [{ displayName: state.contactName }] : []);
      }
      if (req.method === 'GET' && rel === '/handle/availability/imessage') {
        return bbEnvelope({ available: state.imessageAvailable });
      }
      if (req.method === 'GET' && /^\/attachment\/.+\/download$/.test(rel)) {
        return new Response(state.attachmentBytes, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    origin: `http://localhost:${server.port}`,
    requests,
    state,
    count: (method, path) => requests.filter((r) => r.method === method && r.path === path).length,
    reset: () => {
      requests.length = 0;
      Object.assign(state, defaults());
    },
    stop: () => server.stop(true),
  };
}

// ---------------------------------------------------------------------------
// Mock Missive
// ---------------------------------------------------------------------------

/** Mutable behaviour knobs for the mock Missive server. */
export interface MockMissiveState {
  /** Fail the next N `POST /v1/messages` calls before succeeding. */
  failNext: number;
  /** Status to fail with (429 emits a `Retry-After`). */
  failStatus: number;
  /** `Retry-After` seconds emitted on a 429 failure. */
  retryAfterSec: number;
  /** Fail (503) the first post whose `external_id` includes this, once. */
  failExternalId: string | null;
}

/** A running mock Missive server. */
export interface MockMissive {
  /** Origin the routing fetch rewrites Missive calls to. */
  readonly origin: string;
  /** Bodies accepted by `POST /v1/messages`. */
  readonly posts: MissiveInboundBody[];
  /** Bodies accepted by `POST /v1/posts`. */
  readonly comments: unknown[];
  /** Mutable behaviour knobs. */
  readonly state: MockMissiveState;
  /** Clear recorded posts/comments + restore default state. */
  reset(): void;
  /** Shut the server down. */
  stop(): Promise<void>;
}

/** Stand up a mock Missive server on an ephemeral port. */
export function startMockMissive(): MockMissive {
  const posts: MissiveInboundBody[] = [];
  const comments: unknown[] = [];
  const defaults = (): MockMissiveState => ({
    failNext: 0,
    failStatus: 429,
    retryAfterSec: 1,
    failExternalId: null,
  });
  const state: MockMissiveState = defaults();

  const server = Bun.serve({
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        if (state.failNext > 0) {
          state.failNext -= 1;
          const headers: Record<string, string> = {};
          if (state.failStatus === 429) headers['Retry-After'] = String(state.retryAfterSec);
          return new Response('rate limited', { status: state.failStatus, headers });
        }
        const parsed = (await req.json()) as MissiveInboundBody;
        const extId = parsed.messages.external_id;
        if (state.failExternalId != null && extId?.includes(state.failExternalId)) {
          state.failExternalId = null; // fail this specific sub-post exactly once
          return new Response('boom', { status: 503 });
        }
        posts.push(parsed);
        // Missive may answer an empty 201; the client must tolerate no body.
        return new Response(null, { status: 201 });
      }
      if (req.method === 'POST' && url.pathname === '/v1/posts') {
        comments.push(await req.json());
        return new Response(null, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    origin: `http://localhost:${server.port}`,
    posts,
    comments,
    state,
    reset: () => {
      posts.length = 0;
      comments.length = 0;
      Object.assign(state, defaults());
    },
    stop: () => server.stop(true),
  };
}

// ---------------------------------------------------------------------------
// Routing fetch + helpers
// ---------------------------------------------------------------------------

/** Missive REST base the client targets (mirrors `clients/missive.ts`). */
const MISSIVE_ORIGIN = 'https://public.missiveapp.com';

/**
 * Build a `fetch` that rewrites the production base URLs to the mock origins and
 * otherwise delegates to the real fetch, preserving method/body/headers/signal.
 *
 * @param bbOrigin - The mock BlueBubbles origin.
 * @param missiveOrigin - The mock Missive origin.
 * @param realFetch - The genuine fetch used to reach the mock servers.
 */
export function makeRoutingFetch(
  bbOrigin: string,
  missiveOrigin: string,
  realFetch: typeof fetch,
): typeof fetch {
  const routed = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    let target = href;
    if (href.startsWith(config.BB_URL)) {
      target = bbOrigin + href.slice(config.BB_URL.length);
    } else if (href.startsWith(MISSIVE_ORIGIN)) {
      target = missiveOrigin + href.slice(MISSIVE_ORIGIN.length);
    }
    return realFetch(target, init);
  };
  return routed as unknown as typeof fetch;
}

/** Build a correctly HMAC-signed Missive outbound webhook request. */
export function missiveWebhookRequest(hook: unknown): Request {
  const raw = JSON.stringify(hook);
  const sig = `sha256=${createHmac('sha256', config.MISSIVE_HMAC_SECRET).update(raw).digest('hex')}`;
  return new Request('http://bridge.local/missive/webhook', {
    method: 'POST',
    body: raw,
    headers: { 'X-Hook-Signature': sig },
  });
}

/** Build a token-guarded BlueBubbles webhook request for an event. */
export function bbWebhookRequest(evt: unknown): Request {
  return new Request(`http://bridge.local/bb/webhook/${config.BB_HOOK_TOKEN}`, {
    method: 'POST',
    body: JSON.stringify(evt),
    headers: { 'content-type': 'application/json' },
  });
}

/** Poll `pred` until it is truthy or the timeout elapses (throws on timeout). */
export async function waitFor(
  pred: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const intervalMs = opts.intervalMs ?? 15;
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out${opts.label ? `: ${opts.label}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
