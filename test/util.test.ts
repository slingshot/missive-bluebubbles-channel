import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  backoffMs,
  bbDedupKey,
  canonicalHash,
  canonicalStringify,
  constantTimeEqual,
  msToUnix,
  verifyHmac,
} from '../src/util.ts';

describe('verifyHmac', () => {
  const secret = 'top-secret';
  const raw = Buffer.from('the-raw-body-bytes');
  const valid = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

  it('accepts a correct signature over the raw bytes', () => {
    expect(verifyHmac(secret, raw, valid)).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(verifyHmac(secret, raw, null)).toBe(false);
    expect(verifyHmac(secret, raw, undefined)).toBe(false);
    expect(verifyHmac(secret, raw, '')).toBe(false);
  });

  it('rejects a length mismatch without throwing', () => {
    expect(verifyHmac(secret, raw, `${valid}deadbeef`)).toBe(false);
  });

  it('rejects a tampered signature of equal length', () => {
    const tampered = valid.slice(0, -1) + (valid.endsWith('a') ? 'b' : 'a');
    expect(tampered).toHaveLength(valid.length);
    expect(verifyHmac(secret, raw, tampered)).toBe(false);
  });

  it('rejects when the wrong secret is used', () => {
    expect(verifyHmac('other-secret', raw, valid)).toBe(false);
  });
});

describe('constantTimeEqual', () => {
  it('accepts equal strings', () => {
    expect(constantTimeEqual('secret-token', 'secret-token')).toBe(true);
  });

  it('rejects a same-length mismatch', () => {
    expect(constantTimeEqual('secret-token', 'secret-tokeN')).toBe(false);
  });

  it('rejects a different-length string without throwing', () => {
    expect(constantTimeEqual('secret-token', 'secret')).toBe(false);
    expect(constantTimeEqual('', 'x')).toBe(false);
  });
});

describe('msToUnix', () => {
  it('floors epoch ms to whole seconds', () => {
    expect(msToUnix(1_500)).toBe(1);
    expect(msToUnix(1_000)).toBe(1);
    expect(msToUnix(999)).toBe(0);
    expect(msToUnix(1_700_000_000_123)).toBe(1_700_000_000);
  });
});

describe('backoffMs', () => {
  it('returns 0 with a zero rng', () => {
    expect(backoffMs(0, { rng: () => 0 })).toBe(0);
  });

  it('scales by the jitter fraction and attempt', () => {
    expect(backoffMs(0, { rng: () => 0.5, base: 1_000, cap: 300_000 })).toBe(500);
    expect(backoffMs(3, { rng: () => 0.5, base: 1_000, cap: 300_000 })).toBe(4_000);
  });

  it('caps the ceiling for large attempts', () => {
    expect(backoffMs(50, { rng: () => 0.999, base: 1_000, cap: 300_000 })).toBe(299_700);
  });

  it('uses defaults (base/cap/Math.random) when no options given', () => {
    const v = backoffMs(1);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(2_000);
  });
});

describe('canonicalStringify', () => {
  it('serializes primitives', () => {
    expect(canonicalStringify(null)).toBe('null');
    expect(canonicalStringify(5)).toBe('5');
    expect(canonicalStringify('a')).toBe('"a"');
    expect(canonicalStringify(true)).toBe('true');
  });

  it('coerces undefined to null', () => {
    expect(canonicalStringify(undefined)).toBe('null');
  });

  it('serializes arrays recursively', () => {
    expect(canonicalStringify([1, 'a', null])).toBe('[1,"a",null]');
  });

  it('sorts object keys so order does not matter', () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalStringify({ a: 2, b: 1 })).toBe(canonicalStringify({ b: 1, a: 2 }));
  });

  it('handles nested structures', () => {
    expect(canonicalStringify({ z: [{ y: 1, x: 2 }], a: { c: 3, b: 4 } })).toBe(
      '{"a":{"b":4,"c":3},"z":[{"x":2,"y":1}]}',
    );
  });
});

describe('canonicalHash', () => {
  it('is a 64-char hex digest, stable across key order', () => {
    const h1 = canonicalHash({ a: 1, b: 2 });
    const h2 = canonicalHash({ b: 2, a: 1 });
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
  });

  it('differs for different content', () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });
});

describe('bbDedupKey', () => {
  it('keys new-message by guid', () => {
    expect(bbDedupKey('new-message', { guid: 'G1' })).toBe('bb:new-message:G1');
  });

  it('falls back to a hash for a guid-less new-message', () => {
    const key = bbDedupKey('new-message', { text: 'hi' });
    expect(key).toMatch(/^bb:new-message:[0-9a-f]{64}$/);
  });

  it('keys updated-message by guid + delivery/read/edit/retract generations', () => {
    expect(
      bbDedupKey('updated-message', {
        guid: 'G2',
        isDelivered: true,
        dateRead: 123,
        dateEdited: null,
        dateRetracted: undefined,
      }),
    ).toBe('bb:updated:G2:1:123:0:0');
    expect(bbDedupKey('updated-message', { guid: 'G2', isDelivered: false })).toBe(
      'bb:updated:G2:0:0:0:0',
    );
  });

  it('falls back to a hash for a guid-less updated-message', () => {
    expect(bbDedupKey('updated-message', { dateRead: 1 })).toMatch(
      /^bb:updated-message:[0-9a-f]{64}$/,
    );
  });

  it('returns null for ephemeral events', () => {
    expect(bbDedupKey('typing-indicator', { guid: 'C', display: true })).toBeNull();
    expect(bbDedupKey('chat-read-status-changed', { chatGuid: 'C', read: true })).toBeNull();
  });

  it('hashes any other (guid-less) event by type + canonical data', () => {
    expect(bbDedupKey('message-send-error', { error: 22 })).toMatch(
      /^bb:message-send-error:[0-9a-f]{64}$/,
    );
    expect(bbDedupKey('group-name-change', { newName: 'Trip' })).toMatch(
      /^bb:group-name-change:[0-9a-f]{64}$/,
    );
  });

  it('treats null data as an empty object', () => {
    expect(bbDedupKey('new-message', null)).toBe(`bb:new-message:${canonicalHash({})}`);
  });
});
