/**
 * Tests for the application composition + bootstrap (`src/index.ts`).
 *
 * Covers `buildApp` route mounting, `ensureBbWebhook` idempotency (already
 * registered vs create), and the `startServer` onStart boot sequence across all
 * three paths (BlueBubbles reachable -> ready; unreachable -> queue-only; probe
 * error -> caught), plus the worker/re-probe lifecycle on `stop`.
 *
 * External I/O is replaced with `spyOn` on the imported client/domain
 * namespaces (ESM live bindings: the module under test observes the spies). The
 * server binds an ephemeral port (`PORT: 0`) and is always stopped.
 */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as bbClient from '../src/clients/bluebubbles.ts';
import { config } from '../src/config.ts';
import { createDb } from '../src/db.ts';
import * as capability from '../src/domain/capability.ts';
import { buildApp, ensureBbWebhook, startPruneSweep, startServer } from '../src/index.ts';
import * as worker from '../src/queue/outbox.ts';
import type { Caps } from '../src/types.ts';

const WEBHOOK_URL = `${config.PUBLIC_URL}/bb/webhook/${config.BB_HOOK_TOKEN}`;
const CAPS: Caps = { privateApi: true, lastProbeAt: 1 };

/** A test config bound to an ephemeral port. */
const testConfig = { ...config, PORT: 0 };

/** Stub the worker + re-probe so onStart starts no real timers; returns spies. */
function stubLifecycle(): {
  workerStop: ReturnType<typeof mock>;
  reprobeStop: ReturnType<typeof mock>;
} {
  const workerStop = mock(() => Promise.resolve());
  const reprobeStop = mock(() => undefined);
  spyOn(worker, 'startWorker').mockReturnValue({ stop: workerStop });
  spyOn(capability, 'startReprobe').mockReturnValue(reprobeStop);
  return { workerStop, reprobeStop };
}

/** Read the `ready` flag through a fresh (non-listening) app. */
async function readReady(): Promise<boolean> {
  const res = await buildApp(config).handle(new Request('http://localhost/health'));
  return ((await res.json()) as { ready: boolean }).ready;
}

afterEach(() => {
  mock.restore();
});

describe('buildApp', () => {
  it('mounts the health route and reports the boot readiness flag', async () => {
    const res = await buildApp(config).handle(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    expect((await res.json()) as { ready: boolean }).toHaveProperty('ready');
  });
});

describe('ensureBbWebhook', () => {
  it('is a no-op when the exact URL is already registered', async () => {
    spyOn(bbClient, 'listWebhooks').mockResolvedValue([{ url: WEBHOOK_URL }]);
    const create = spyOn(bbClient, 'createWebhook').mockResolvedValue(undefined);

    await ensureBbWebhook(config);
    expect(create).not.toHaveBeenCalled();
  });

  it('creates the webhook when the URL is absent', async () => {
    spyOn(bbClient, 'listWebhooks').mockResolvedValue([{ url: 'https://elsewhere/hook' }]);
    const create = spyOn(bbClient, 'createWebhook').mockResolvedValue(undefined);

    await ensureBbWebhook(config);
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0]?.[0] as { url: string; events: readonly string[] };
    expect(arg.url).toBe(WEBHOOK_URL);
    expect(arg.events).toContain('new-message');
  });
});

describe('startServer', () => {
  it('boots ready when BlueBubbles is reachable and self-registers the webhook', async () => {
    const ping = spyOn(bbClient, 'ping').mockResolvedValue(true);
    const detect = spyOn(capability, 'detect').mockResolvedValue(CAPS);
    spyOn(bbClient, 'listWebhooks').mockResolvedValue([]);
    const create = spyOn(bbClient, 'createWebhook').mockResolvedValue(undefined);
    const { workerStop, reprobeStop } = stubLifecycle();

    const handle = await startServer(testConfig);

    expect(ping).toHaveBeenCalled();
    expect(detect).toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);

    const res = await handle.app.handle(new Request('http://localhost/health'));
    expect(((await res.json()) as { ready: boolean }).ready).toBe(true);

    await handle.stop();
    expect(workerStop).toHaveBeenCalledTimes(1);
    expect(reprobeStop).toHaveBeenCalledTimes(1);
    // stop resets readiness.
    expect(await readReady()).toBe(false);
  });

  it('stays not-ready (queue-only) when BlueBubbles is unreachable at boot', async () => {
    spyOn(bbClient, 'ping').mockResolvedValue(false);
    const detect = spyOn(capability, 'detect').mockResolvedValue(CAPS);
    stubLifecycle();

    const handle = await startServer(testConfig);

    expect(detect).not.toHaveBeenCalled();
    const res = await handle.app.handle(new Request('http://localhost/health'));
    expect(((await res.json()) as { ready: boolean }).ready).toBe(false);

    await handle.stop();
  });

  it('catches a boot probe error and still starts the worker', async () => {
    spyOn(bbClient, 'ping').mockResolvedValue(true);
    spyOn(capability, 'detect').mockRejectedValue(new Error('server/info failed'));
    const { workerStop } = stubLifecycle();

    const handle = await startServer(testConfig);

    const res = await handle.app.handle(new Request('http://localhost/health'));
    expect(((await res.json()) as { ready: boolean }).ready).toBe(false);

    await handle.stop();
    expect(workerStop).toHaveBeenCalledTimes(1);
  });
});

describe('startPruneSweep', () => {
  it('prunes on each interval (retention horizon) and stops cleanly', async () => {
    const clock = 100_000_000;
    const d = createDb(':memory:', () => clock);
    const prune = spyOn(d, 'pruneOld');

    const stop = startPruneSweep(d, 1, 30_000);
    // A tick must fire pruneOld with now - retention.
    await new Promise((resolve) => setTimeout(resolve, 15));
    stop();
    const ticks = prune.mock.calls.length;
    expect(ticks).toBeGreaterThanOrEqual(1);
    expect(prune.mock.calls[0]?.[0]).toBe(clock - 30_000);

    // No further sweeps once stopped.
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(prune.mock.calls.length).toBe(ticks);
    d.close();
  });
});
