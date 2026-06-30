/**
 * Missive rate limiter — a token-bucket concurrency + rate governor.
 *
 * Missive's REST API is globally limited to **5 concurrent**, **5 req/s burst**,
 * and **~1 req/s sustained** (see the plan's "Verified API contract"). This
 * limiter enforces all three at once:
 *
 *  - **Concurrency:** at most `maxConcurrent` permits are ever in flight.
 *  - **Rate:** a bucket holds up to `burst` tokens, refilled at `ratePerSec`
 *    tokens/second; every acquire spends one token. A cold bucket can fire a
 *    `burst` of calls immediately, then settles to the sustained `ratePerSec`.
 *
 * A caller either wraps work with {@link Limiter.run} (recommended) or manually
 * {@link Limiter.acquire}s a permit and invokes the returned release function.
 * Releasing is idempotent. The scheduler is event-driven (no busy polling): a
 * permit is granted the instant a slot **and** a token are both available, and a
 * single refill timer is armed only while a waiter is blocked purely on tokens.
 *
 * `now` and `sleep` are injectable so the bucket math is fully deterministic
 * under test (virtual time), with no real timers.
 */

/** Limiter tunables. */
export interface LimiterOptions {
  /** Max concurrent permits (default 5). */
  maxConcurrent?: number;
  /** Sustained permits per second (default 1). */
  ratePerSec?: number;
  /** Maximum burst size (default 5). */
  burst?: number;
  /** Time source (epoch ms); overridable for deterministic tests. */
  now?: () => number;
  /** Delay scheduler; overridable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** A concurrency + rate governor. */
export interface Limiter {
  /** Acquire a permit; resolves with a release function to call when done. */
  acquire(): Promise<() => void>;
  /** Acquire, run `fn`, and release (even on throw). */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Number of permits currently in flight. */
  readonly inFlight: number;
}

/**
 * Create a {@link Limiter} from the given options.
 *
 * @param opts - Tunables; sensible Missive-shaped defaults are used for any
 *   omitted field (`maxConcurrent=5`, `ratePerSec=1`, `burst=5`).
 */
export function createLimiter(opts: LimiterOptions = {}): Limiter {
  const maxConcurrent = opts.maxConcurrent ?? 5;
  const ratePerSec = opts.ratePerSec ?? 1;
  const burst = opts.burst ?? 5;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        // Unref'd (like the worker/reprobe timers) so a token-blocked wait never
        // keeps the event loop alive on its own and delays a clean shutdown.
        setTimeout(resolve, ms).unref?.();
      }));

  /** Available tokens (fractional); starts full so a cold bucket can burst. */
  let tokens = burst;
  /** Timestamp the bucket was last refilled. */
  let last = now();
  /** Permits currently in flight. */
  let inFlight = 0;
  /** FIFO of pending acquire resolvers awaiting a slot + token. */
  const waiters: Array<(release: () => void) => void> = [];
  /** True while a single refill timer is armed (prevents duplicate timers). */
  let timerArmed = false;

  /** Accrue tokens for the elapsed wall-clock time, capped at `burst`. */
  const refill = (): void => {
    const t = now();
    const elapsed = t - last;
    if (elapsed > 0) {
      tokens = Math.min(burst, tokens + (elapsed / 1000) * ratePerSec);
      last = t;
    }
  };

  /** Build an idempotent release function for one granted permit. */
  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight -= 1;
      pump();
    };
  };

  /** Grant as many waiters as slots + tokens allow; arm a refill timer if needed. */
  const pump = (): void => {
    refill();
    while (waiters.length > 0 && inFlight < maxConcurrent && tokens >= 1) {
      tokens -= 1;
      inFlight += 1;
      const resolve = waiters.shift() as (release: () => void) => void;
      resolve(makeRelease());
    }
    // Still want to grant but only tokens are short -> wait exactly long enough
    // for the next token to accrue, then re-pump. (Concurrency-blocked waiters
    // are instead woken by release().)
    if (waiters.length > 0 && inFlight < maxConcurrent && tokens < 1 && !timerArmed) {
      timerArmed = true;
      const delayMs = Math.ceil(((1 - tokens) / ratePerSec) * 1000);
      void sleep(delayMs).then(() => {
        timerArmed = false;
        pump();
      });
    }
  };

  const acquire = (): Promise<() => void> =>
    new Promise<() => void>((resolve) => {
      waiters.push(resolve);
      pump();
    });

  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    const release = await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };

  return {
    acquire,
    run,
    get inFlight() {
      return inFlight;
    },
  };
}
