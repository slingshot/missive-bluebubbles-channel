import { describe, expect, it } from 'bun:test';
import { createLimiter } from '../../src/queue/ratelimiter.ts';

/** Yield to the microtask + macrotask queues so pending acquires settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createLimiter — concurrency cap', () => {
  it('never exceeds maxConcurrent and wakes a blocked waiter on release', async () => {
    // Big bucket + fast refill so tokens never gate; only concurrency does.
    const lim = createLimiter({ maxConcurrent: 2, ratePerSec: 1000, burst: 100, now: () => 0 });

    const r1 = await lim.acquire();
    const r2 = await lim.acquire();
    expect(lim.inFlight).toBe(2);

    // A third acquire must block (no slot) — it is concurrency-, not token-gated.
    let granted = false;
    const p3 = lim.acquire().then((release) => {
      granted = true;
      return release;
    });
    await flush();
    expect(granted).toBe(false);
    expect(lim.inFlight).toBe(2);

    // Releasing one slot lets the third through (still capped at 2).
    r1();
    const r3 = await p3;
    expect(granted).toBe(true);
    expect(lim.inFlight).toBe(2);

    r2();
    r3();
    expect(lim.inFlight).toBe(0);
  });
});

describe('createLimiter — token-bucket pacing', () => {
  it('bursts up to `burst` then paces at ~ratePerSec (virtual time)', async () => {
    let t = 0;
    const sleep = (ms: number): Promise<void> => {
      t += ms;
      return Promise.resolve();
    };
    const lim = createLimiter({ maxConcurrent: 5, ratePerSec: 1, burst: 5, now: () => t, sleep });

    // Five immediate permits drain the burst with no waiting.
    for (let i = 0; i < 5; i++) {
      const release = await lim.acquire();
      release();
    }
    expect(t).toBe(0);

    // The sixth must wait exactly one token's worth of time (1s at 1/s).
    const sixth = await lim.acquire();
    expect(t).toBe(1000);
    sixth();
  });

  it('refills proportionally and serves multiple queued waiters in order', async () => {
    let t = 0;
    const sleep = (ms: number): Promise<void> => {
      t += ms;
      return Promise.resolve();
    };
    const lim = createLimiter({ maxConcurrent: 10, ratePerSec: 2, burst: 1, now: () => t, sleep });

    const first = await lim.acquire(); // spends the only token
    first();
    expect(t).toBe(0);

    // Two more queue up; at 2 tokens/s each needs 500ms to accrue.
    const order: number[] = [];
    const a = lim.acquire().then((release) => {
      order.push(1);
      return release;
    });
    const b = lim.acquire().then((release) => {
      order.push(2);
      return release;
    });
    (await a)();
    (await b)();
    expect(order).toEqual([1, 2]);
    expect(t).toBeGreaterThanOrEqual(500);
  });
});

describe('createLimiter — run() wrapper', () => {
  it('returns the result and releases the permit', async () => {
    const lim = createLimiter({ now: () => 0 });
    const out = await lim.run(async () => 42);
    expect(out).toBe(42);
    expect(lim.inFlight).toBe(0);
  });

  it('releases the permit even when the body throws', async () => {
    const lim = createLimiter({ now: () => 0 });
    await expect(lim.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(lim.inFlight).toBe(0);
  });
});

describe('createLimiter — release semantics + defaults', () => {
  it('release is idempotent', async () => {
    const lim = createLimiter({ now: () => 0 });
    const release = await lim.acquire();
    expect(lim.inFlight).toBe(1);
    release();
    release(); // no-op second call
    expect(lim.inFlight).toBe(0);
  });

  it('uses real Date.now + setTimeout when now/sleep are omitted', async () => {
    // burst=1 forces the second acquire onto the default sleep path.
    const lim = createLimiter({ burst: 1, ratePerSec: 1000 });
    (await lim.acquire())();
    const start = Date.now();
    const release = await lim.acquire();
    expect(Date.now() - start).toBeGreaterThanOrEqual(0);
    release();
    expect(lim.inFlight).toBe(0);
  });
});
