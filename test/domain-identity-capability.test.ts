/**
 * Unit tests for the identity + capability domain modules.
 *
 * Both modules call into `src/clients/bluebubbles.ts`. To keep these tests
 * hermetic (no real network) we `spyOn` the three client functions they use on
 * the imported module namespace; ESM live bindings mean the modules-under-test
 * observe the spies. Unlike a process-global `mock.module()` (which strips the
 * client's other exports — breaking sibling test files that statically import
 * `listWebhooks` / `sendAttachment` — and leaks mocked state across files), a
 * `spyOn` leaves the rest of the client intact, calls through when no
 * implementation is set, and is fully reverted by `mock.restore()`.
 */

import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { BbClientOptions } from '../src/clients/bluebubbles.ts';
import * as bb from '../src/clients/bluebubbles.ts';
import { detect, getCaps, startReprobe } from '../src/domain/capability.ts';
import { resolveName } from '../src/domain/identity.ts';

// --- Spied BlueBubbles client surface (only the three calls our modules use) --

/** `handle/query` — confirms a handle and returns its canonical address. */
const queryHandle = spyOn(bb, 'queryHandle');
/** `contact/query` — returns a display name when one is known. */
const queryContact = spyOn(bb, 'queryContact');
/** `server/info` — the Private-API capability flags. */
const serverInfo = spyOn(bb, 'serverInfo');

/** Small async delay (test-time timers are permitted). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `cond()` is true or the timeout elapses. */
async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await delay(2);
  }
}

/** A controllable in-memory `handle_map` cache stand-in. */
function makeCache(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const getCachedName = mock((address: string): string | null => store.get(address) ?? null);
  const cacheName = mock((address: string, name: string): void => {
    store.set(address, name);
  });
  return { store, getCachedName, cacheName };
}

beforeEach(() => {
  queryHandle.mockReset();
  queryContact.mockReset();
  serverInfo.mockReset();
  queryHandle.mockResolvedValue(null);
  queryContact.mockResolvedValue(null);
  serverInfo.mockResolvedValue({ private_api: false, helper_connected: false });
});

afterAll(() => {
  // Undo the module mock so it cannot leak into other test files.
  mock.restore();
});

// ---------------------------------------------------------------------------
// identity.resolveName
// ---------------------------------------------------------------------------

describe('identity.resolveName', () => {
  it('returns the cached name without touching the network', async () => {
    const cache = makeCache({ '+15551112222': 'Cached Carol' });

    const name = await resolveName('+15551112222', {
      getCachedName: cache.getCachedName,
      cacheName: cache.cacheName,
    });

    expect(name).toBe('Cached Carol');
    expect(queryHandle).not.toHaveBeenCalled();
    expect(queryContact).not.toHaveBeenCalled();
    expect(cache.cacheName).not.toHaveBeenCalled();
  });

  it('prefers a contact display name and caches it, forwarding client opts', async () => {
    const cache = makeCache();
    const client: BbClientOptions = { signal: AbortSignal.timeout(5_000) };
    queryHandle.mockResolvedValue({ address: '+15553334444' });
    queryContact.mockResolvedValue({ displayName: 'Alice Anderson' });

    const name = await resolveName('+15553334444', {
      getCachedName: cache.getCachedName,
      cacheName: cache.cacheName,
      client,
    });

    expect(name).toBe('Alice Anderson');
    expect(cache.store.get('+15553334444')).toBe('Alice Anderson');
    // Both BlueBubbles lookups receive the address + the injected client opts.
    expect(queryHandle).toHaveBeenCalledWith('+15553334444', client);
    expect(queryContact).toHaveBeenCalledWith('+15553334444', client);
  });

  it('falls back to the canonical handle address when the contact name is blank', async () => {
    const cache = makeCache();
    queryHandle.mockResolvedValue({ address: '+15555556666' });
    // Whitespace-only display name trims to empty -> not usable.
    queryContact.mockResolvedValue({ displayName: '   ' });

    const name = await resolveName('15555556666', {
      getCachedName: cache.getCachedName,
      cacheName: cache.cacheName,
    });

    expect(name).toBe('+15555556666');
    expect(cache.store.get('15555556666')).toBe('+15555556666');
  });

  it('falls back to the raw address when neither lookup yields anything', async () => {
    const cache = makeCache();
    queryHandle.mockResolvedValue(null);
    queryContact.mockResolvedValue(null);

    const name = await resolveName('unknown@example.com', {
      getCachedName: cache.getCachedName,
      cacheName: cache.cacheName,
    });

    expect(name).toBe('unknown@example.com');
    expect(cache.cacheName).toHaveBeenCalledWith('unknown@example.com', 'unknown@example.com');
  });

  it('degrades to the raw address (and caches it) on a transport error', async () => {
    const cache = makeCache();
    queryHandle.mockRejectedValue(new Error('bb unreachable'));

    const name = await resolveName('+15557778888', {
      getCachedName: cache.getCachedName,
      cacheName: cache.cacheName,
    });

    expect(name).toBe('+15557778888');
    expect(cache.store.get('+15557778888')).toBe('+15557778888');
  });

  it('uses a contact name even when handle/query returns null', async () => {
    const cache = makeCache();
    queryHandle.mockResolvedValue(null);
    queryContact.mockResolvedValue({ displayName: 'Bob' });

    const name = await resolveName('+15559990000', {
      getCachedName: cache.getCachedName,
      cacheName: cache.cacheName,
    });

    expect(name).toBe('Bob');
  });
});

// ---------------------------------------------------------------------------
// capability.detect / getCaps / startReprobe
//
// NOTE: the "default before first probe" assertion below MUST run before any
// `detect()` call mutates the module-level snapshot, so it is the first test in
// this block and no earlier test in this file probes capability.
// ---------------------------------------------------------------------------

describe('capability.detect', () => {
  it('returns the no-Private-API default before the first probe', () => {
    const caps = getCaps();
    expect(caps.privateApi).toBe(false);
    expect(caps.helperConnected).toBe(false);
    expect(caps.lastProbeAt).toBe(0);
  });

  it('reports privateApi=true only when BOTH flags are true', async () => {
    serverInfo.mockResolvedValue({ private_api: true, helper_connected: true });
    const before = Date.now();

    const caps = await detect();

    expect(caps.privateApi).toBe(true);
    expect(caps.helperConnected).toBe(true);
    expect(caps.lastProbeAt).toBeGreaterThanOrEqual(before);
    expect(caps.lastProbeAt).toBeLessThanOrEqual(Date.now());
    // getCaps reflects the latest probe.
    expect(getCaps()).toEqual(caps);
  });

  it('reports privateApi=false when helper_connected is false (but tracks helperConnected raw)', async () => {
    serverInfo.mockResolvedValue({ private_api: true, helper_connected: false });
    const caps = await detect();
    expect(caps.privateApi).toBe(false);
    expect(caps.helperConnected).toBe(false);
  });

  it('reports privateApi=false when private_api is false (even though helperConnected is raw-true)', async () => {
    serverInfo.mockResolvedValue({ private_api: false, helper_connected: true });
    const caps = await detect();
    expect(caps.privateApi).toBe(false);
    expect(caps.helperConnected).toBe(true);
  });

  it('forwards client opts to server/info', async () => {
    serverInfo.mockResolvedValue({ private_api: false, helper_connected: false });
    const opts: BbClientOptions = { signal: AbortSignal.timeout(5_000) };

    await detect(opts);

    expect(serverInfo).toHaveBeenCalledWith(opts);
  });
});

describe('capability.startReprobe', () => {
  it('re-probes on each interval and stops cleanly', async () => {
    serverInfo.mockResolvedValue({ private_api: true, helper_connected: true });

    const stop = startReprobe(10);
    // A tick must fire detect, which flips the cached caps to privateApi=true.
    await waitFor(() => serverInfo.mock.calls.length > 0);
    await waitFor(() => getCaps().privateApi === true);
    expect(getCaps().privateApi).toBe(true);

    stop();
    const callsAfterStop = serverInfo.mock.calls.length;
    await delay(40);
    // No further probes once stopped.
    expect(serverInfo.mock.calls.length).toBe(callsAfterStop);
  });

  it('swallows probe errors so a transient outage does not crash the timer', async () => {
    // Seed a known-good snapshot, then make probes fail.
    serverInfo.mockResolvedValueOnce({ private_api: true, helper_connected: true });
    await detect();
    const snapshot = getCaps();

    serverInfo.mockReset();
    serverInfo.mockRejectedValue(new Error('server/info down'));

    const stop = startReprobe(10);
    await waitFor(() => serverInfo.mock.calls.length > 0);
    // Give the rejected probe a moment to settle (its .catch must run).
    await delay(20);
    stop();

    // The failed probe left the last-known-good snapshot untouched.
    expect(getCaps()).toEqual(snapshot);
  });
});
