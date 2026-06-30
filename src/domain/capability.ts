/**
 * Capability detection.
 *
 * BlueBubbles Private-API features (react / edit / unsend / upload / multipart)
 * are available **iff** `GET /server/info` reports both `private_api === true`
 * AND `helper_connected === true`. The bridge probes once on boot, re-probes on
 * an interval, and degrades gracefully (apple-script text) when the Private API
 * is unavailable — it never hard-fails a send for a missing capability.
 *
 * {@link detect} performs a probe and updates the cached snapshot;
 * {@link getCaps} returns the cached snapshot (a sensible "no Private API"
 * default until the first probe); {@link startReprobe} schedules periodic
 * re-probing and returns a stop function.
 */

import type { BbClientOptions } from '../clients/bluebubbles.ts';
import { serverInfo } from '../clients/bluebubbles.ts';
import type { Caps } from '../types.ts';

/**
 * The most recent capability snapshot. Defaults to "no Private API" with a zero
 * probe timestamp so callers can tell a probe has never succeeded.
 */
let currentCaps: Caps = { privateApi: false, lastProbeAt: 0 };

/**
 * Probe BlueBubbles `server/info` and recompute the capability snapshot.
 *
 * Private-API availability requires BOTH flags to be strictly `true`; any other
 * combination yields `privateApi: false`.
 *
 * @param opts - Optional BlueBubbles client options (fetch override, signal).
 * @returns The freshly-computed capability snapshot (also cached internally).
 */
export async function detect(opts?: BbClientOptions): Promise<Caps> {
  const info = await serverInfo(opts);
  currentCaps = {
    privateApi: info.private_api === true && info.helper_connected === true,
    lastProbeAt: Date.now(),
  };
  return currentCaps;
}

/** Return the most recent capability snapshot (defaults until the first probe). */
export function getCaps(): Caps {
  return currentCaps;
}

/**
 * Begin periodic re-probing every `intervalMs`. A failed probe is swallowed so a
 * transient BlueBubbles outage keeps the last-known-good snapshot rather than
 * crashing the timer. The timer is unref'd so it never keeps the process alive
 * on its own (the HTTP listener does that in production).
 *
 * @param intervalMs - Re-probe interval in milliseconds (`CAPS_REPROBE_MS`).
 * @param opts - Optional BlueBubbles client options forwarded to {@link detect}.
 * @returns A stop function that cancels the timer.
 */
export function startReprobe(intervalMs: number, opts?: BbClientOptions): () => void {
  const timer = setInterval(() => {
    detect(opts).catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
  };
}
