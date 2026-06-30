import { describe, expect, it, spyOn } from 'bun:test';
import {
  createLogger,
  defaultWrite,
  isSecretKey,
  type LogMeta,
  logger,
  REDACTED,
  redact,
} from '../src/logger.ts';

/** Build a logger that captures emitted JSON records into an array. */
function capturing(level: 'debug' | 'info' | 'warn' | 'error') {
  const lines: string[] = [];
  const log = createLogger({ level, write: (l) => lines.push(l) });
  return { log, records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('createLogger — level filtering', () => {
  it('drops records below the configured threshold', () => {
    const { log, records } = capturing('warn');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    const levels = records().map((r) => r.level);
    expect(levels).toEqual(['warn', 'error']);
  });

  it('emits a structured record with level/time/msg', () => {
    const { log, records } = capturing('debug');
    log.info('hello');
    const [rec] = records();
    expect(rec?.level).toBe('info');
    expect(rec?.msg).toBe('hello');
    expect(typeof rec?.time).toBe('string');
  });

  it('omits meta keys when no meta is supplied', () => {
    const { log, records } = capturing('debug');
    log.debug('bare');
    expect(Object.keys(records()[0] ?? {})).toEqual(['level', 'time', 'msg']);
  });
});

describe('createLogger — redaction', () => {
  it('redacts secret-keyed values recursively', () => {
    const { log, records } = capturing('debug');
    const meta: LogMeta = {
      password: 'hunter2',
      plain: 'visible',
      nested: { token: 'abc', ok: 1 },
      arr: [{ secret: 'z' }, { fine: true }],
    };
    log.info('m', meta);
    const rec = records()[0] as Record<string, unknown>;
    expect(rec.password).toBe(REDACTED);
    expect(rec.plain).toBe('visible');
    expect((rec.nested as Record<string, unknown>).token).toBe(REDACTED);
    expect((rec.nested as Record<string, unknown>).ok).toBe(1);
    const arr = rec.arr as Array<Record<string, unknown>>;
    expect(arr[0]?.secret).toBe(REDACTED);
    expect(arr[1]?.fine).toBe(true);
  });
});

describe('redact', () => {
  it('passes primitives through untouched', () => {
    expect(redact(5)).toBe(5);
    expect(redact('a')).toBe('a');
    expect(redact(null)).toBeNull();
    expect(redact(true)).toBe(true);
  });

  it('maps arrays element-wise', () => {
    expect(redact([1, { token: 'x' }])).toEqual([1, { token: REDACTED }]);
  });

  it('redacts only secret keys in objects', () => {
    expect(redact({ authorization: 'Bearer x', user: 'sam' })).toEqual({
      authorization: REDACTED,
      user: 'sam',
    });
  });
});

describe('isSecretKey', () => {
  it('matches secret-ish names case-insensitively', () => {
    expect(isSecretKey('password')).toBe(true);
    expect(isSecretKey('Authorization')).toBe(true);
    expect(isSecretKey('API_KEY')).toBe(true);
    expect(isSecretKey('base64_data')).toBe(true);
    expect(isSecretKey('plainField')).toBe(false);
  });
});

describe('defaultWrite + singleton', () => {
  it('writes a line via console.log', () => {
    const spy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      defaultWrite('a-line');
      expect(spy).toHaveBeenCalledWith('a-line');
    } finally {
      spy.mockRestore();
    }
  });

  it('uses the default sink when none is provided', () => {
    const spy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const log = createLogger({ level: 'info' });
      log.info('via-default');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('exposes a process-wide logger', () => {
    const spy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      logger.debug('singleton'); // LOG_LEVEL=debug in tests
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
