/**
 * BlueBubbles REST client.
 *
 * Every call targets `<BB_URL>/api/v1<path>?password=<pw>` (see {@link bb}),
 * carries an `AbortSignal.timeout()` (overridable), and throws a typed
 * {@link BbError} whose `retryable` flag tells the worker whether to back off
 * (5xx / 429 / network) or dead-letter (4xx). A `fetch` override is accepted
 * everywhere for tests.
 *
 * Route paths + body field names are mirrored from the BlueBubbles server
 * source (`api/http/api/v1/httpRoutes.ts` + the per-router validators). Every
 * successful response is the standard `{ status, message, data }` envelope, so
 * the typed helpers unwrap `.data`.
 *
 * Private-API-only calls (react/edit/unsend/upload/multipart, plus iMessage
 * availability) require server capabilities; the caller gates them.
 */

import { config } from '../config.ts';
import type { BbChat, BbMessage, Service } from '../types.ts';

/** The subset of `fetch` this client depends on (overridable in tests). */
export type FetchLike = typeof fetch;

/** Common per-call options. */
export interface BbClientOptions {
  /** Override the global fetch (for tests / instrumentation). */
  fetch?: FetchLike;
  /** Abort signal (defaults to an internal `AbortSignal.timeout()`). */
  signal?: AbortSignal;
}

/** BlueBubbles send method. `apple-script` requires `tempGuid` + `message`. */
export type BbMethod = 'apple-script' | 'private-api';

/** A typed BlueBubbles client error. */
export class BbError extends Error {
  /** True for transient failures the worker should retry (5xx / 429 / network). */
  readonly retryable: boolean;
  /** Upstream HTTP status, when applicable. */
  readonly status: number | undefined;
  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = 'BbError';
    this.retryable = retryable;
    this.status = status;
  }
}

/** Server-info capability flags. */
export interface BbServerInfo {
  readonly private_api: boolean;
  readonly helper_connected: boolean;
}

/** Default request timeout for JSON calls (ms). */
const JSON_TIMEOUT_MS = 30_000;
/** Larger timeout for attachment transfers (ms). */
const ATTACHMENT_TIMEOUT_MS = 60_000;

/** Build a fully-qualified BlueBubbles API URL with the password query param. */
export function bb(path: string): string {
  return `${config.BB_URL}/api/v1${path}?password=${encodeURIComponent(config.BB_PASSWORD)}`;
}

/** Extract a human-readable message from an unknown thrown value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A request body is either a JSON value or a multipart form. */
interface SendSpec {
  /** JSON body (serialized + `Content-Type: application/json`). */
  readonly json?: unknown;
  /** Multipart body (no manual `Content-Type`; fetch sets the boundary). */
  readonly form?: FormData;
  /** Extra query params appended after `?password=` (values are encoded). */
  readonly query?: Record<string, string>;
  /** Override the default timeout. */
  readonly timeoutMs?: number;
}

/**
 * Perform a single BlueBubbles HTTP call, returning the raw `Response` on 2xx
 * and throwing a typed {@link BbError} otherwise. The relative `path` (never
 * the password-bearing URL) is used in error messages so secrets never leak.
 */
async function send(
  method: string,
  path: string,
  spec: SendSpec,
  opts: BbClientOptions | undefined,
): Promise<Response> {
  const doFetch = opts?.fetch ?? fetch;
  const timeoutMs = spec.timeoutMs ?? JSON_TIMEOUT_MS;
  const signal = opts?.signal ?? AbortSignal.timeout(timeoutMs);

  let url = bb(path);
  if (spec.query) {
    for (const [k, v] of Object.entries(spec.query)) {
      url += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    }
  }

  const init: RequestInit = { method, signal };
  if (spec.form) {
    init.body = spec.form;
  } else if (spec.json !== undefined) {
    init.body = JSON.stringify(spec.json);
    init.headers = { 'Content-Type': 'application/json' };
  }

  let res: Response;
  try {
    res = await doFetch(url, init);
  } catch (err) {
    throw new BbError(`BlueBubbles ${method} ${path} request failed: ${errMessage(err)}`, true);
  }
  if (!res.ok) {
    const retryable = res.status >= 500 || res.status === 429;
    throw new BbError(`BlueBubbles ${method} ${path} -> ${res.status}`, retryable, res.status);
  }
  return res;
}

/** Perform a call and unwrap the `{ data }` envelope to `T`. */
async function sendJson<T>(
  method: string,
  path: string,
  spec: SendSpec,
  opts: BbClientOptions | undefined,
): Promise<T> {
  const res = await send(method, path, spec, opts);
  const body = (await res.json()) as { data?: T };
  return body.data as T;
}

/** `POST /api/v1/message/text`. */
export function sendText(
  args: { chatGuid: string; tempGuid: string; message: string; method?: BbMethod },
  opts?: BbClientOptions,
): Promise<BbMessage> {
  return sendJson<BbMessage>(
    'POST',
    '/message/text',
    {
      json: {
        chatGuid: args.chatGuid,
        tempGuid: args.tempGuid,
        message: args.message,
        method: args.method ?? 'apple-script',
      },
    },
    opts,
  );
}

/** `POST /api/v1/message/attachment` (multipart; file field `attachment`). */
export function sendAttachment(form: FormData, opts?: BbClientOptions): Promise<BbMessage> {
  return sendJson<BbMessage>(
    'POST',
    '/message/attachment',
    { form, timeoutMs: ATTACHMENT_TIMEOUT_MS },
    opts,
  );
}

/** `POST /api/v1/chat/new` — creates a chat AND sends the first message. */
export async function chatNew(
  args: {
    addresses: readonly string[];
    message?: string;
    service?: Service;
    method?: BbMethod;
    tempGuid?: string;
  },
  opts?: BbClientOptions,
): Promise<{ guid: string }> {
  const data = await sendJson<{ guid?: string }>(
    'POST',
    '/chat/new',
    {
      json: {
        addresses: args.addresses,
        message: args.message,
        method: args.method ?? 'apple-script',
        service: args.service ?? config.DEFAULT_SERVICE,
        tempGuid: args.tempGuid,
      },
    },
    opts,
  );
  return { guid: data.guid as string };
}

/** `POST /api/v1/chat/query` — find chats (used to resolve existing DMs). */
export async function queryChats(
  args: { guids?: readonly string[]; limit?: number; offset?: number },
  opts?: BbClientOptions,
): Promise<BbChat[]> {
  const json: Record<string, unknown> = { with: [], limit: args.limit, offset: args.offset };
  if (args.guids && args.guids.length > 0) {
    json.guid = args.guids[0];
  }
  const data = await sendJson<BbChat[]>('POST', '/chat/query', { json }, opts);
  return data ?? [];
}

/** `POST /api/v1/handle/query` — resolve a handle by address. */
export async function queryHandle(
  address: string,
  opts?: BbClientOptions,
): Promise<{ address: string } | null> {
  const data = await sendJson<Array<{ address?: string }>>(
    'POST',
    '/handle/query',
    { json: { address } },
    opts,
  );
  const first = data?.[0];
  return first?.address != null ? { address: first.address } : null;
}

/** `POST /api/v1/contact/query` — resolve a contact (display name) by address. */
export async function queryContact(
  address: string,
  opts?: BbClientOptions,
): Promise<{ displayName?: string } | null> {
  const data = await sendJson<Array<{ displayName?: string }>>(
    'POST',
    '/contact/query',
    { json: { addresses: [address] } },
    opts,
  );
  const first = data?.[0];
  if (!first) return null;
  return first.displayName != null ? { displayName: first.displayName } : {};
}

/**
 * `GET /api/v1/handle/availability/imessage` — whether an address is reachable
 * over iMessage (the SMS-fallback gate). Private-API gated on the server.
 */
export async function handleAvailabilityImessage(
  address: string,
  opts?: BbClientOptions,
): Promise<boolean> {
  const data = await sendJson<{ available?: boolean }>(
    'GET',
    '/handle/availability/imessage',
    { query: { address } },
    opts,
  );
  return data?.available === true;
}

/** `GET /api/v1/attachment/:guid/download` — raw bytes (`original=false` transcodes). */
export async function downloadAttachment(
  guid: string,
  args?: { original?: boolean },
  opts?: BbClientOptions,
): Promise<Uint8Array> {
  const query: Record<string, string> = {};
  if (args?.original !== undefined) {
    query.original = String(args.original);
  }
  const res = await send(
    'GET',
    `/attachment/${encodeURIComponent(guid)}/download`,
    { query, timeoutMs: ATTACHMENT_TIMEOUT_MS },
    opts,
  );
  return new Uint8Array(await res.arrayBuffer());
}

/** `GET /api/v1/server/info` — capability flags. */
export async function serverInfo(opts?: BbClientOptions): Promise<BbServerInfo> {
  const data = await sendJson<Record<string, unknown>>('GET', '/server/info', {}, opts);
  return {
    private_api: data?.private_api === true,
    helper_connected: data?.helper_connected === true,
  };
}

/** `GET /api/v1/ping` — liveness. Never throws; resolves `false` on any failure. */
export async function ping(opts?: BbClientOptions): Promise<boolean> {
  try {
    await send('GET', '/ping', {}, opts);
    return true;
  } catch {
    return false;
  }
}

/** `GET /api/v1/webhook` — list registered webhooks (for idempotent self-register). */
export async function listWebhooks(opts?: BbClientOptions): Promise<Array<{ url: string }>> {
  const data = await sendJson<Array<{ url: string }>>('GET', '/webhook', {}, opts);
  return (data ?? []).map((w) => ({ url: w.url }));
}

/** `POST /api/v1/webhook` — register a webhook target. */
export async function createWebhook(
  args: { url: string; events: readonly string[] },
  opts?: BbClientOptions,
): Promise<void> {
  await sendJson('POST', '/webhook', { json: { url: args.url, events: args.events } }, opts);
}

/** (Private API) `POST /api/v1/message/react`. */
export function react(
  args: { chatGuid: string; selectedMessageGuid: string; reaction: string; partIndex?: number },
  opts?: BbClientOptions,
): Promise<BbMessage> {
  return sendJson<BbMessage>(
    'POST',
    '/message/react',
    {
      json: {
        chatGuid: args.chatGuid,
        selectedMessageGuid: args.selectedMessageGuid,
        reaction: args.reaction,
        partIndex: args.partIndex ?? 0,
      },
    },
    opts,
  );
}

/** (Private API) `POST /api/v1/message/:guid/edit`. */
export async function edit(
  args: {
    guid: string;
    editedMessage: string;
    backwardsCompatMessage?: string;
    partIndex?: number;
  },
  opts?: BbClientOptions,
): Promise<void> {
  await sendJson(
    'POST',
    `/message/${encodeURIComponent(args.guid)}/edit`,
    {
      json: {
        editedMessage: args.editedMessage,
        backwardsCompatibilityMessage: args.backwardsCompatMessage ?? args.editedMessage,
        partIndex: args.partIndex ?? 0,
      },
    },
    opts,
  );
}

/** (Private API) `POST /api/v1/message/:guid/unsend`. */
export async function unsend(
  args: { guid: string; partIndex?: number },
  opts?: BbClientOptions,
): Promise<void> {
  await sendJson(
    'POST',
    `/message/${encodeURIComponent(args.guid)}/unsend`,
    { json: { partIndex: args.partIndex ?? 0 } },
    opts,
  );
}

/** (Private API) `POST /api/v1/attachment/upload` — pre-upload bytes for multipart. */
export async function uploadAttachment(
  form: FormData,
  opts?: BbClientOptions,
): Promise<{ guid: string }> {
  const data = await sendJson<{ path?: string; guid?: string }>(
    'POST',
    '/attachment/upload',
    { form, timeoutMs: ATTACHMENT_TIMEOUT_MS },
    opts,
  );
  return { guid: (data?.guid ?? data?.path) as string };
}

/** (Private API) `POST /api/v1/message/multipart` — mixed text + media in one message. */
export function sendMultipart(
  args: {
    chatGuid: string;
    tempGuid: string;
    parts: ReadonlyArray<{ type: 'text'; text: string } | { type: 'attachment'; guid: string }>;
  },
  opts?: BbClientOptions,
): Promise<BbMessage> {
  const parts = args.parts.map((p, i) =>
    p.type === 'text' ? { partIndex: i, text: p.text } : { partIndex: i, attachment: p.guid },
  );
  return sendJson<BbMessage>(
    'POST',
    '/message/multipart',
    { json: { chatGuid: args.chatGuid, tempGuid: args.tempGuid, parts } },
    opts,
  );
}
