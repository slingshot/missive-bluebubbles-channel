/**
 * Pure, dependency-light utilities: HMAC verification, time conversion,
 * retry backoff, canonical hashing, and BlueBubbles dedup-key derivation.
 *
 * Everything here is a pure function so it is exhaustively unit-testable with
 * no I/O.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// HMAC
// ---------------------------------------------------------------------------

/**
 * Constant-time verification of a Missive `X-Hook-Signature` header against the
 * RAW request bytes.
 *
 * The expected value is `"sha256=" + HMAC_SHA256_hex(raw, secret)`. We length-
 * check before {@link timingSafeEqual} (which throws on unequal lengths) and
 * never re-serialize parsed JSON for the digest.
 *
 * @param secret - The shared signing secret.
 * @param raw - The raw request body bytes (never the re-serialized JSON).
 * @param header - The received `X-Hook-Signature` value (may be absent).
 * @returns `true` iff the signature is present and matches.
 */
export function verifyHmac(
  secret: string,
  raw: Uint8Array | Buffer,
  header: string | null | undefined,
): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/**
 * Constant-time string comparison (length-checked so it never throws). Used to
 * guard token-in-path routes (BlueBubbles webhook, dashboard) against timing
 * probes; the length check itself leaks only the length, which is acceptable
 * for high-entropy tokens.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Convert epoch milliseconds to Unix seconds (Missive timestamps are seconds).
 * @param ms - Epoch milliseconds.
 */
export function msToUnix(ms: number): number {
  return Math.floor(ms / 1000);
}

// ---------------------------------------------------------------------------
// Retry backoff
// ---------------------------------------------------------------------------

/** Tunables for {@link backoffMs} (overridable for deterministic tests). */
export interface BackoffOptions {
  /** Base delay in ms (default 1000). */
  base?: number;
  /** Maximum delay in ms (default 300000 = 5 min). */
  cap?: number;
  /** Random source in [0,1) (default {@link Math.random}). */
  rng?: () => number;
}

/**
 * Exponential backoff with full jitter, capped. The returned delay is a random
 * value in `[0, min(cap, base * 2^attempt))`.
 *
 * @param attempt - Zero-based attempt number.
 * @param opts - Optional tunables (inject `rng` for deterministic tests).
 */
export function backoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.base ?? 1000;
  const cap = opts.cap ?? 300_000;
  const rng = opts.rng ?? Math.random;
  const ceiling = Math.min(cap, base * 2 ** attempt);
  return Math.floor(rng() * ceiling);
}

// ---------------------------------------------------------------------------
// Canonical hashing (stable across key order)
// ---------------------------------------------------------------------------

/**
 * Deterministically serialize a value with object keys sorted recursively, so
 * two structurally-equal objects always produce an identical string regardless
 * of property insertion order.
 *
 * @param value - Any JSON-serializable value.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * SHA-256 hex digest of {@link canonicalStringify}'s output. Used to build a
 * stable dedup key for BlueBubbles events that carry no message guid.
 *
 * @param data - Any JSON-serializable value.
 */
export function canonicalHash(data: unknown): string {
  return createHash('sha256').update(canonicalStringify(data)).digest('hex');
}

// ---------------------------------------------------------------------------
// BlueBubbles dedup keys (invariant #2 / #3)
// ---------------------------------------------------------------------------

/**
 * Derive the persistent dedup key for a BlueBubbles webhook event.
 *
 * - `new-message` (incl. tapbacks)  -> `bb:new-message:<guid>`
 * - `updated-message`               -> `bb:updated:<guid>:<isDelivered?1:0>:<dateRead??0>:<dateEdited??0>:<dateRetracted??0>`
 * - `typing-indicator` / `chat-read-status-changed` -> `null` (ephemeral, never persistently deduped)
 * - any other (no guid)             -> `bb:<type>:<canonicalHash(data)>`
 *
 * A message event missing its `guid` falls back to the hashed form so we can
 * NEVER emit a `...:undefined:undefined` key that collapses distinct events
 * into one dedup slot.
 *
 * @returns The dedup key, or `null` for ephemeral events the route must
 *   handle in-memory rather than persist.
 */
export function bbDedupKey(type: string, data: unknown): string | null {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (type) {
    case 'new-message':
      return d.guid != null ? `bb:new-message:${d.guid}` : `bb:${type}:${canonicalHash(d)}`;
    case 'updated-message': {
      if (d.guid == null) return `bb:${type}:${canonicalHash(d)}`;
      const isDelivered = d.isDelivered ? 1 : 0;
      const dateRead = (d.dateRead as number | null | undefined) ?? 0;
      const dateEdited = (d.dateEdited as number | null | undefined) ?? 0;
      const dateRetracted = (d.dateRetracted as number | null | undefined) ?? 0;
      return `bb:updated:${d.guid}:${isDelivered}:${dateRead}:${dateEdited}:${dateRetracted}`;
    }
    case 'typing-indicator':
    case 'chat-read-status-changed':
      return null;
    default:
      return `bb:${type}:${canonicalHash(d)}`;
  }
}
