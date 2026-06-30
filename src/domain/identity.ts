/**
 * Identity resolution.
 *
 * Maps a raw address (phone / email) to a human display name, cached in
 * `handle_map`. Resolution order:
 *
 *   1. `handle_map` cache (the injected accessor enforces any TTL / staleness
 *      policy; a stale entry returns `null` and triggers a refresh here).
 *   2. `handle/query` — confirms a real iMessage/SMS handle and yields its
 *      canonical address (the ultimate fallback).
 *   3. `contact/query` — the only source of a human-friendly display name.
 *   4. The raw address itself when nothing better exists, or on any transport
 *      error (name resolution must never block inbound message delivery).
 *
 * The resolved value is written back through the cache so the next lookup is a
 * hit and `updated_at` is refreshed.
 */

import type { BbClientOptions } from '../clients/bluebubbles.ts';
import { queryContact, queryHandle } from '../clients/bluebubbles.ts';

/** Injected dependencies for {@link resolveName} (enables 100%-coverage tests). */
export interface IdentityDeps {
  /** Read the cached name for an address (or `null` when missing/stale). */
  getCachedName(address: string): string | null;
  /** Persist a resolved name for an address (refreshing its TTL). */
  cacheName(address: string, name: string): void;
  /** BlueBubbles client options (fetch override, signal). */
  client?: BbClientOptions;
}

/**
 * Resolve a display name for an address, populating the cache on a miss.
 *
 * @param address - The raw handle address to resolve.
 * @param deps - Injected cache accessors + BlueBubbles client options.
 * @returns The resolved display name, or the address itself when nothing
 *   better exists.
 */
export async function resolveName(address: string, deps: IdentityDeps): Promise<string> {
  // 1. Cache (TTL is the accessor's concern; `null` means miss or stale).
  const cached = deps.getCachedName(address);
  if (cached !== null) return cached;

  // 2/3. Resolve via BlueBubbles. Prefer a contact display name; otherwise the
  //       canonical handle; otherwise the raw address. Degrade gracefully on any
  //       transport error so inbound posting is never blocked on a lookup.
  let resolved: string;
  try {
    const handle = await queryHandle(address, deps.client);
    const contact = await queryContact(address, deps.client);
    const display = contact?.displayName?.trim();
    resolved = display || handle?.address || address;
  } catch {
    resolved = address;
  }

  // 4. Cache (refresh `updated_at`) and return.
  deps.cacheName(address, resolved);
  return resolved;
}
