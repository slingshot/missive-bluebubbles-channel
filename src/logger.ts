/**
 * Leveled JSON-line logger that redacts secrets.
 *
 * Each call emits a single JSON object (`{level,time,msg,...meta}`) through a
 * pluggable `write` sink. Any meta field whose key looks secret-ish (password,
 * token, secret, authorization, base64 payload, ...) is replaced with `***`,
 * recursively. Levels below the configured threshold are dropped.
 */

import { config } from './config.ts';
import type { LogLevel } from './types.ts';

/** Numeric severity for each level (higher = more severe). */
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Substrings (case-insensitive) that mark a meta key as secret. */
const REDACT_KEYS = [
  'password',
  'token',
  'secret',
  'authorization',
  'auth',
  'base64_data',
  'base64',
  'apikey',
  'api_key',
] as const;

/** The redaction placeholder substituted for secret values. */
export const REDACTED = '***';

/** Arbitrary structured metadata attached to a log line. */
export type LogMeta = Record<string, unknown>;

/** A leveled logger. */
export interface Logger {
  debug(msg: string, meta?: LogMeta): void;
  info(msg: string, meta?: LogMeta): void;
  warn(msg: string, meta?: LogMeta): void;
  error(msg: string, meta?: LogMeta): void;
}

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  /** Minimum level to emit. */
  level: LogLevel;
  /** Output sink (default: write a line to stdout via {@link console.log}). */
  write?: (line: string) => void;
}

/** Default sink — one JSON line per record on stdout. */
export function defaultWrite(line: string): void {
  console.log(line);
}

/** Return true if a key name indicates a secret value. */
export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return REDACT_KEYS.some((needle) => k.includes(needle));
}

/**
 * Deep-clone `value`, replacing any secret-keyed value with {@link REDACTED}.
 * Arrays are mapped element-wise; primitives pass through untouched.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? REDACTED : redact(val);
    }
    return out;
  }
  return value;
}

/**
 * Create a leveled logger.
 *
 * @param opts - Level threshold and optional output sink.
 */
export function createLogger(opts: LoggerOptions): Logger {
  const threshold = LEVELS[opts.level];
  const write = opts.write ?? defaultWrite;

  const emit = (level: LogLevel, msg: string, meta?: LogMeta): void => {
    if (LEVELS[level] < threshold) return;
    const record: Record<string, unknown> = {
      level,
      time: new Date().toISOString(),
      msg,
    };
    if (meta !== undefined) {
      Object.assign(record, redact(meta) as Record<string, unknown>);
    }
    write(JSON.stringify(record));
  };

  return {
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
  };
}

/** The process-wide logger, configured from {@link config.LOG_LEVEL}. */
export const logger: Logger = createLogger({ level: config.LOG_LEVEL });
