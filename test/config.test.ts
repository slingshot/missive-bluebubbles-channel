import { describe, expect, it } from 'bun:test';
import {
  assertUrl,
  config,
  type Env,
  loadConfig,
  MIN_HOOK_TOKEN_LENGTH,
  parseBool,
  parseIntField,
  stripTrailingSlash,
} from '../src/config.ts';

/** A complete, valid environment (every required key present). */
function validEnv(overrides: Env = {}): Env {
  return {
    BB_URL: 'http://localhost:1234',
    BB_PASSWORD: 'pw',
    MISSIVE_TOKEN: 'missive_pat-abc',
    MISSIVE_ACCOUNT_ID: 'acct',
    MISSIVE_HMAC_SECRET: 'secret',
    PUBLIC_URL: 'https://bridge.example.com',
    BB_HOOK_TOKEN: 'a'.repeat(MIN_HOOK_TOKEN_LENGTH),
    SELF_HANDLE: '+15555550123',
    ...overrides,
  };
}

describe('loadConfig — happy paths', () => {
  it('applies defaults for omitted optionals', () => {
    const c = loadConfig(validEnv());
    expect(c.SELF_NAME).toBe('Me');
    expect(c.PORT).toBe(3000);
    expect(c.DB_PATH).toBe('./data/bridge.sqlite');
    expect(c.DEFAULT_SERVICE).toBe('iMessage');
    expect(c.ATTACHMENT_ORIGINAL).toBe(false);
    expect(c.MISSIVE_MAX_PAYLOAD_BYTES).toBe(9_500_000);
    expect(c.RECEIPTS_AS_POSTS).toBe(false);
    expect(c.CAPS_REPROBE_MS).toBe(300_000);
    expect(c.LOG_LEVEL).toBe('info');
  });

  it('reads and coerces every optional when provided', () => {
    const c = loadConfig(
      validEnv({
        SELF_NAME: 'Bridge',
        PORT: '8080',
        DB_PATH: '/var/db/bridge.sqlite',
        DEFAULT_SERVICE: 'SMS',
        ATTACHMENT_ORIGINAL: 'true',
        MISSIVE_MAX_PAYLOAD_BYTES: '5000000',
        RECEIPTS_AS_POSTS: 'yes',
        CAPS_REPROBE_MS: '60000',
        LOG_LEVEL: 'warn',
        PUBLIC_URL: 'https://bridge.example.com/',
      }),
    );
    expect(c.SELF_NAME).toBe('Bridge');
    expect(c.PORT).toBe(8080);
    expect(c.DB_PATH).toBe('/var/db/bridge.sqlite');
    expect(c.DEFAULT_SERVICE).toBe('SMS');
    expect(c.ATTACHMENT_ORIGINAL).toBe(true);
    expect(c.MISSIVE_MAX_PAYLOAD_BYTES).toBe(5_000_000);
    expect(c.RECEIPTS_AS_POSTS).toBe(true);
    expect(c.CAPS_REPROBE_MS).toBe(60_000);
    expect(c.LOG_LEVEL).toBe('warn');
    // trailing slash stripped
    expect(c.PUBLIC_URL).toBe('https://bridge.example.com');
  });

  it('treats blank optionals as unset (default fallback)', () => {
    const c = loadConfig(validEnv({ SELF_NAME: '', DB_PATH: '   ' }));
    expect(c.SELF_NAME).toBe('Me');
    expect(c.DB_PATH).toBe('./data/bridge.sqlite');
  });

  it('returns a frozen object', () => {
    const c = loadConfig(validEnv());
    expect(Object.isFrozen(c)).toBe(true);
  });
});

describe('loadConfig — validation failures', () => {
  it('throws listing each missing required key (incl. whitespace-only)', () => {
    let err: Error | undefined;
    try {
      loadConfig(validEnv({ BB_URL: undefined, BB_PASSWORD: '   ' }));
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err?.message).toContain('BB_URL is required');
    expect(err?.message).toContain('BB_PASSWORD is required');
  });

  it('rejects malformed URLs', () => {
    expect(() => loadConfig(validEnv({ BB_URL: 'not a url' }))).toThrow(
      /BB_URL must be a valid URL/,
    );
    expect(() => loadConfig(validEnv({ PUBLIC_URL: 'nope' }))).toThrow(
      /PUBLIC_URL must be a valid URL/,
    );
  });

  it('rejects a short hook token', () => {
    expect(() => loadConfig(validEnv({ BB_HOOK_TOKEN: 'short' }))).toThrow(
      /BB_HOOK_TOKEN must be at least/,
    );
  });

  it('rejects non-positive-integer numbers', () => {
    expect(() => loadConfig(validEnv({ PORT: 'abc' }))).toThrow(/PORT must be a positive integer/);
    expect(() => loadConfig(validEnv({ PORT: '0' }))).toThrow(/PORT must be a positive integer/);
    expect(() => loadConfig(validEnv({ PORT: '3.5' }))).toThrow(/PORT must be a positive integer/);
    expect(() => loadConfig(validEnv({ MISSIVE_MAX_PAYLOAD_BYTES: '-1' }))).toThrow(
      /MISSIVE_MAX_PAYLOAD_BYTES must be a positive integer/,
    );
    expect(() => loadConfig(validEnv({ CAPS_REPROBE_MS: 'NaN' }))).toThrow(
      /CAPS_REPROBE_MS must be a positive integer/,
    );
  });

  it('rejects invalid booleans', () => {
    expect(() => loadConfig(validEnv({ ATTACHMENT_ORIGINAL: 'maybe' }))).toThrow(
      /ATTACHMENT_ORIGINAL must be a boolean/,
    );
    expect(() => loadConfig(validEnv({ RECEIPTS_AS_POSTS: 'sometimes' }))).toThrow(
      /RECEIPTS_AS_POSTS must be a boolean/,
    );
  });

  it('rejects invalid enums', () => {
    expect(() => loadConfig(validEnv({ DEFAULT_SERVICE: 'Carrier' }))).toThrow(
      /DEFAULT_SERVICE must be one of/,
    );
    expect(() => loadConfig(validEnv({ LOG_LEVEL: 'verbose' }))).toThrow(
      /LOG_LEVEL must be one of/,
    );
  });
});

describe('DASHBOARD_TOKEN', () => {
  it('is null when unset', () => {
    const c = loadConfig(validEnv());
    expect(c.DASHBOARD_TOKEN).toBeNull();
  });

  it('treats an empty/whitespace value as unset (null)', () => {
    expect(loadConfig(validEnv({ DASHBOARD_TOKEN: '' })).DASHBOARD_TOKEN).toBeNull();
    expect(loadConfig(validEnv({ DASHBOARD_TOKEN: '   ' })).DASHBOARD_TOKEN).toBeNull();
  });

  it('rejects a token shorter than the minimum length', () => {
    expect(() => loadConfig(validEnv({ DASHBOARD_TOKEN: 'short' }))).toThrow(
      /DASHBOARD_TOKEN must be at least/,
    );
  });

  it('accepts a valid token verbatim', () => {
    const token = 'd'.repeat(MIN_HOOK_TOKEN_LENGTH);
    expect(loadConfig(validEnv({ DASHBOARD_TOKEN: token })).DASHBOARD_TOKEN).toBe(token);
  });
});

describe('parseBool', () => {
  it('falls back when unset/blank', () => {
    const e: string[] = [];
    expect(parseBool(undefined, true, 'X', e)).toBe(true);
    expect(parseBool('', false, 'X', e)).toBe(false);
    expect(e).toHaveLength(0);
  });

  it('parses truthy and falsy spellings (any case)', () => {
    const e: string[] = [];
    for (const v of ['true', 'TRUE', '1', 'yes']) expect(parseBool(v, false, 'X', e)).toBe(true);
    for (const v of ['false', '0', 'no']) expect(parseBool(v, true, 'X', e)).toBe(false);
    expect(e).toHaveLength(0);
  });

  it('records an error and returns the fallback for garbage', () => {
    const e: string[] = [];
    expect(parseBool('bogus', true, 'X', e)).toBe(true);
    expect(e).toHaveLength(1);
  });
});

describe('parseIntField', () => {
  it('falls back when unset/blank', () => {
    const e: string[] = [];
    expect(parseIntField(undefined, 7, 'X', e)).toBe(7);
    expect(parseIntField('', 7, 'X', e)).toBe(7);
    expect(e).toHaveLength(0);
  });

  it('parses positive integers', () => {
    const e: string[] = [];
    expect(parseIntField('42', 7, 'X', e)).toBe(42);
    expect(e).toHaveLength(0);
  });

  it('records an error for non-positive / non-integer / non-numeric', () => {
    const e: string[] = [];
    expect(parseIntField('abc', 7, 'X', e)).toBe(7);
    expect(parseIntField('0', 7, 'X', e)).toBe(7);
    expect(parseIntField('-1', 7, 'X', e)).toBe(7);
    expect(parseIntField('3.5', 7, 'X', e)).toBe(7);
    expect(e).toHaveLength(4);
  });
});

describe('assertUrl', () => {
  it('passes a valid URL', () => {
    const e: string[] = [];
    assertUrl('https://ok.test/path', 'X', e);
    expect(e).toHaveLength(0);
  });

  it('records an error for an invalid URL', () => {
    const e: string[] = [];
    assertUrl('::::', 'X', e);
    expect(e).toHaveLength(1);
  });
});

describe('stripTrailingSlash', () => {
  it('removes a single trailing slash only when present', () => {
    expect(stripTrailingSlash('https://x.test/')).toBe('https://x.test');
    expect(stripTrailingSlash('https://x.test')).toBe('https://x.test');
  });
});

describe('config singleton', () => {
  it('is built and frozen from the test environment', () => {
    expect(Object.isFrozen(config)).toBe(true);
    expect(config.MISSIVE_ACCOUNT_ID).toBe('acct-test-0001');
    expect(config.DB_PATH).toBe(':memory:');
  });
});
