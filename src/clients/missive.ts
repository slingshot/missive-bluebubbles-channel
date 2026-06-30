/**
 * Missive REST client.
 *
 * Bearer-authenticated, 30s timeout. {@link callMissive} translates upstream
 * failures into a typed {@link MissiveError}: `429` -> `retryAfterMs` parsed
 * from `Retry-After` (the worker reschedules with exactly that delay); `4xx` ->
 * `permanent` (dead-letter); `5xx`/network -> `retryable`.
 *
 * Higher-level helpers wrap the two endpoints the bridge uses: `POST /messages`
 * (inject an inbound message into the custom channel) and `POST /posts` (surface
 * a receipt as a conversation comment when `RECEIPTS_AS_POSTS` is enabled).
 *
 * Source of truth: Missive REST API (`https://public.missiveapp.com/v1`,
 * `Authorization: Bearer <missive_pat-…>`). The create-message body is wrapped
 * in a `messages` object and the create-post body in a `posts` object.
 */

import { config } from '../config.ts';
import type { MissiveInboundBody } from '../types.ts';
import type { FetchLike } from './bluebubbles.ts';

export type { FetchLike };

/** Missive REST API base (versioned). */
const MISSIVE_BASE = 'https://public.missiveapp.com/v1';

/** Default per-request timeout (ms). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Common per-call options. */
export interface MissiveClientOptions {
  /** Override the global fetch (for tests / instrumentation). */
  fetch?: FetchLike;
  /** Abort signal (defaults to an internal `AbortSignal.timeout(30_000)`). */
  signal?: AbortSignal;
}

/** A typed Missive client error. */
export class MissiveError extends Error {
  /** True for transient failures the worker should retry (5xx / network). */
  readonly retryable: boolean;
  /** True for non-retryable client errors (4xx except 429). */
  readonly permanent: boolean;
  /** For 429s: the exact delay (ms) parsed from `Retry-After`. */
  readonly retryAfterMs: number | undefined;
  /** Upstream HTTP status, when applicable. */
  readonly status: number | undefined;
  constructor(
    message: string,
    opts: { retryable?: boolean; permanent?: boolean; retryAfterMs?: number; status?: number } = {},
  ) {
    super(message);
    this.name = 'MissiveError';
    this.retryable = opts.retryable ?? false;
    this.permanent = opts.permanent ?? false;
    this.retryAfterMs = opts.retryAfterMs;
    this.status = opts.status;
  }
}

/**
 * Parse a `Retry-After` header into a delay in milliseconds.
 *
 * Per RFC 7231 the value is either a non-negative integer count of seconds or
 * an HTTP-date. A date already in the past clamps to `0`. Anything missing or
 * unparseable yields `undefined` (the worker then falls back to its backoff).
 *
 * @param header - The raw `Retry-After` header value (may be absent).
 * @param nowMs - Current epoch ms, used to diff an HTTP-date.
 */
function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - nowMs);
}

/**
 * Perform a raw authenticated Missive REST call. Resolves with the `Response`
 * on 2xx; throws {@link MissiveError} otherwise (parsing `Retry-After` on 429).
 *
 * The caller is responsible for `Content-Type` and the request body; this
 * function only forces the `Authorization` header, the base URL, and a timeout.
 *
 * @param path - Path relative to `https://public.missiveapp.com/v1`.
 * @param init - Standard `fetch` init (method/body/headers).
 * @param opts - Optional `fetch` / `signal` overrides.
 */
export async function callMissive(
  path: string,
  init?: RequestInit,
  opts?: MissiveClientOptions,
): Promise<Response> {
  const fetchFn = opts?.fetch ?? fetch;
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${config.MISSIVE_TOKEN}`);
  const signal = opts?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchFn(`${MISSIVE_BASE}${path}`, { ...init, headers, signal });
  } catch (err) {
    throw new MissiveError(`Missive request failed: ${(err as Error).message}`, {
      retryable: true,
    });
  }

  if (res.ok) return res;

  if (res.status === 429) {
    const retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'), Date.now());
    // `exactOptionalPropertyTypes` forbids assigning an explicit `undefined` to
    // the optional `retryAfterMs`, so only include it when actually parsed.
    const errOpts: { retryable: boolean; status: number; retryAfterMs?: number } = {
      retryable: true,
      status: 429,
    };
    if (retryAfterMs !== undefined) errOpts.retryAfterMs = retryAfterMs;
    throw new MissiveError('Missive rate limited (429)', errOpts);
  }

  if (res.status >= 500) {
    throw new MissiveError(`Missive server error (${res.status})`, {
      retryable: true,
      status: res.status,
    });
  }

  throw new MissiveError(`Missive client error (${res.status})`, {
    permanent: true,
    status: res.status,
  });
}

/**
 * `POST /v1/messages` — inject an inbound message into the custom channel.
 *
 * The body is sent verbatim (already wrapped in a `messages` object). A
 * successful create may return an empty `201` with no body; we never read it
 * back (all correlation is client-side), so an empty success is tolerated.
 *
 * @param body - The fully-built {@link MissiveInboundBody}.
 * @param opts - Optional `fetch` / `signal` overrides.
 */
export async function postInboundMessage(
  body: MissiveInboundBody,
  opts?: MissiveClientOptions,
): Promise<void> {
  await callMissive(
    '/messages',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts,
  );
}

/**
 * `POST /v1/posts` — append a comment to an existing conversation via the
 * Missive Posts API. Used for `RECEIPTS_AS_POSTS` (surfacing delivered/read).
 *
 * Missive requires `username` and a `notification {title, body}`; the comment
 * `text` doubles as the notification body so the post both threads into the
 * conversation and renders a notification.
 *
 * @param args.conversationId - The Missive conversation to append to.
 * @param args.text - The comment text.
 * @param opts - Optional `fetch` / `signal` overrides.
 */
export async function postConversationComment(
  args: { conversationId: string; text: string },
  opts?: MissiveClientOptions,
): Promise<void> {
  const payload = {
    posts: {
      username: config.SELF_NAME,
      conversation: args.conversationId,
      text: args.text,
      notification: { title: config.SELF_NAME, body: args.text },
    },
  };
  await callMissive(
    '/posts',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    opts,
  );
}
