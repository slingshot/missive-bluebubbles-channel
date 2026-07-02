/**
 * Configuration loader — the ONLY module that reads `process.env`.
 *
 * `loadConfig()` validates and freezes a {@link Config}, throwing a single
 * aggregated error listing every problem. The frozen default {@link config} is
 * built at import time (fail-fast). Tests pass an override env object to
 * exercise validation without touching the real environment.
 */

import type { Config, LogLevel, Service } from './types.ts';

/** A loose environment map (a subset of `process.env`). */
export type Env = Record<string, string | undefined>;

const REQUIRED_KEYS = [
  'BB_URL',
  'BB_PASSWORD',
  'MISSIVE_TOKEN',
  'MISSIVE_ACCOUNT_ID',
  'MISSIVE_HMAC_SECRET',
  'PUBLIC_URL',
  'BB_HOOK_TOKEN',
  'SELF_HANDLE',
] as const;

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const SERVICES: readonly Service[] = ['iMessage', 'SMS'];

/** Minimum length for the BlueBubbles webhook guard token. */
export const MIN_HOOK_TOKEN_LENGTH = 32;

/**
 * Parse a boolean-ish env value. Accepts `true/false/1/0/yes/no` (any case).
 * Pushes an error for any other non-empty value.
 */
export function parseBool(
  value: string | undefined,
  fallback: boolean,
  name: string,
  errors: string[],
): boolean {
  if (value === undefined || value === '') return fallback;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  errors.push(`${name} must be a boolean (true/false), got "${value}"`);
  return fallback;
}

/**
 * Parse a positive integer env value, falling back to `fallback` when unset.
 * Pushes an error for non-numeric / non-positive values.
 */
export function parseIntField(
  value: string | undefined,
  fallback: number,
  name: string,
  errors: string[],
): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    errors.push(`${name} must be a positive integer, got "${value}"`);
    return fallback;
  }
  return n;
}

/** Validate that a string is a parseable absolute URL; push an error if not. */
export function assertUrl(value: string, name: string, errors: string[]): void {
  try {
    // Constructed purely to validate parseability; the instance is discarded.
    void new URL(value);
  } catch {
    errors.push(`${name} must be a valid URL, got "${value}"`);
  }
}

/**
 * Build, validate, and freeze a {@link Config} from an environment map.
 *
 * @param env - Environment source. Defaults to `process.env`.
 * @throws {Error} If any required key is missing or any value is invalid. The
 *   error message aggregates every problem so a single boot surfaces them all.
 */
export function loadConfig(env: Env = process.env): Config {
  const errors: string[] = [];

  // Required, non-empty strings.
  for (const key of REQUIRED_KEYS) {
    const value = env[key];
    if (value === undefined || value.trim() === '') {
      errors.push(`${key} is required but missing/empty`);
    }
  }

  // URL-shaped required values (only checked when present).
  if (env.BB_URL) assertUrl(env.BB_URL, 'BB_URL', errors);
  if (env.PUBLIC_URL) assertUrl(env.PUBLIC_URL, 'PUBLIC_URL', errors);

  // Hook token strength.
  if (env.BB_HOOK_TOKEN && env.BB_HOOK_TOKEN.length < MIN_HOOK_TOKEN_LENGTH) {
    errors.push(`BB_HOOK_TOKEN must be at least ${MIN_HOOK_TOKEN_LENGTH} characters`);
  }

  // Optional dashboard guard token; unset/empty disables the dashboard.
  const DASHBOARD_TOKEN =
    env.DASHBOARD_TOKEN && env.DASHBOARD_TOKEN.trim() !== '' ? env.DASHBOARD_TOKEN : null;
  if (DASHBOARD_TOKEN !== null && DASHBOARD_TOKEN.length < MIN_HOOK_TOKEN_LENGTH) {
    errors.push(`DASHBOARD_TOKEN must be at least ${MIN_HOOK_TOKEN_LENGTH} characters`);
  }

  // Optionals with defaults.
  const PORT = parseIntField(env.PORT, 3000, 'PORT', errors);
  const MISSIVE_MAX_PAYLOAD_BYTES = parseIntField(
    env.MISSIVE_MAX_PAYLOAD_BYTES,
    9_500_000,
    'MISSIVE_MAX_PAYLOAD_BYTES',
    errors,
  );
  const CAPS_REPROBE_MS = parseIntField(env.CAPS_REPROBE_MS, 300_000, 'CAPS_REPROBE_MS', errors);
  const ATTACHMENT_ORIGINAL = parseBool(
    env.ATTACHMENT_ORIGINAL,
    false,
    'ATTACHMENT_ORIGINAL',
    errors,
  );
  const RECEIPTS_AS_POSTS = parseBool(env.RECEIPTS_AS_POSTS, false, 'RECEIPTS_AS_POSTS', errors);

  // Enumerated optionals.
  const DEFAULT_SERVICE = (env.DEFAULT_SERVICE ?? 'iMessage') as Service;
  if (!SERVICES.includes(DEFAULT_SERVICE)) {
    errors.push(
      `DEFAULT_SERVICE must be one of ${SERVICES.join('/')}, got "${env.DEFAULT_SERVICE}"`,
    );
  }

  const LOG_LEVEL = (env.LOG_LEVEL ?? 'info') as LogLevel;
  if (!LOG_LEVELS.includes(LOG_LEVEL)) {
    errors.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join('/')}, got "${env.LOG_LEVEL}"`);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }

  // After validation every required key is present; the non-null assertions are
  // sound because the loop above would have thrown otherwise.
  const cfg: Config = {
    BB_URL: env.BB_URL as string,
    BB_PASSWORD: env.BB_PASSWORD as string,
    MISSIVE_TOKEN: env.MISSIVE_TOKEN as string,
    MISSIVE_ACCOUNT_ID: env.MISSIVE_ACCOUNT_ID as string,
    MISSIVE_HMAC_SECRET: env.MISSIVE_HMAC_SECRET as string,
    PUBLIC_URL: stripTrailingSlash(env.PUBLIC_URL as string),
    BB_HOOK_TOKEN: env.BB_HOOK_TOKEN as string,
    DASHBOARD_TOKEN,
    SELF_HANDLE: env.SELF_HANDLE as string,
    SELF_NAME: env.SELF_NAME && env.SELF_NAME.trim() !== '' ? env.SELF_NAME : 'Me',
    PORT,
    DB_PATH: env.DB_PATH && env.DB_PATH.trim() !== '' ? env.DB_PATH : './data/bridge.sqlite',
    DEFAULT_SERVICE,
    ATTACHMENT_ORIGINAL,
    MISSIVE_MAX_PAYLOAD_BYTES,
    RECEIPTS_AS_POSTS,
    CAPS_REPROBE_MS,
    LOG_LEVEL,
  };

  return Object.freeze(cfg);
}

/** Remove a single trailing slash so URL joins don't double up. */
export function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** The validated, frozen runtime configuration (fail-fast at import). */
export const config: Config = loadConfig();
