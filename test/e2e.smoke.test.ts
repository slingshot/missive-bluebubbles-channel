/**
 * End-to-end smoke test — boots the REAL application (`startServer`, the same
 * entry the `import.meta.main` guard runs in production) against `Bun.serve` mock
 * BlueBubbles + Missive servers.
 *
 * Unlike `integration.test.ts` (which drives the outbox synchronously), this
 * exercises the genuine wired process: the `onStart` boot sequence (ping ->
 * capability detect -> idempotent webhook self-registration), the real background
 * outbox worker, and `/health`. Because `startServer` resolves its clients
 * through the global `fetch`, the suite routes `fetch` to the mocks for the file
 * and restores it afterward.
 *
 * Asserts: boots ready, self-registers exactly once (idempotent across reboots),
 * degrades gracefully when the Private API is off, and round-trips a full
 * outbound send + genuine inbound message with NO echo loop.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { getCaps } from '../src/domain/capability.ts';
import { type AppHandle, startServer } from '../src/index.ts';
import type { Caps, MissiveInboundBody } from '../src/types.ts';
import {
  bbWebhookRequest,
  type MockBlueBubbles,
  type MockMissive,
  makeRoutingFetch,
  missiveWebhookRequest,
  startMockBlueBubbles,
  startMockMissive,
  waitFor,
} from './support/mocks.ts';

/** Boot on an ephemeral port so nothing collides with a real listener. */
const TEST_CONFIG = { ...config, PORT: 0 };

/** The self-registration URL the bridge must POST to BlueBubbles exactly once. */
const WEBHOOK_URL = `${config.PUBLIC_URL}/bb/webhook/${config.BB_HOOK_TOKEN}`;

let bb: MockBlueBubbles;
let missive: MockMissive;
let realFetch: typeof fetch;

beforeAll(() => {
  realFetch = globalThis.fetch;
  bb = startMockBlueBubbles();
  missive = startMockMissive();
  // startServer's clients use the global fetch; route it to the mocks.
  globalThis.fetch = makeRoutingFetch(bb.origin, missive.origin, realFetch);
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await bb.stop();
  await missive.stop();
});

beforeEach(() => {
  bb.reset();
  missive.reset();
});

/** Read the `/health` body from a running handle. */
async function health(handle: AppHandle): Promise<{ ready: boolean; caps: Caps }> {
  const res = await handle.app.handle(new Request('http://bridge.local/health'));
  return (await res.json()) as { ready: boolean; caps: Caps };
}

/** Pending (undispatched) outbox depth on the process-wide db. */
function pending(): number {
  return Number(
    (
      db.raw.query("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'").get() as {
        n: number;
      }
    ).n,
  );
}

describe('boot + self-registration', () => {
  it('boots ready and self-registers the webhook exactly once, idempotent on reboot', async () => {
    bb.state.privateApi = true;
    bb.state.helperConnected = true;

    const first = await startServer(TEST_CONFIG);
    try {
      expect((await health(first)).ready).toBe(true);
      expect(bb.state.webhooks).toEqual([WEBHOOK_URL]);
      expect(bb.count('POST', '/webhook')).toBe(1);
    } finally {
      await first.stop();
    }

    // Reboot against the SAME BlueBubbles (webhook already present) -> no re-create.
    const second = await startServer(TEST_CONFIG);
    try {
      expect(bb.count('POST', '/webhook')).toBe(1); // still one — idempotent
      expect(bb.state.webhooks).toEqual([WEBHOOK_URL]); // not duplicated
    } finally {
      await second.stop();
    }
  });

  it('degrades gracefully (still ready) when the Private API is off', async () => {
    bb.state.privateApi = false;
    bb.state.helperConnected = false;

    const handle = await startServer(TEST_CONFIG);
    try {
      const report = await health(handle);
      expect(report.ready).toBe(true); // degraded, not failed
      expect(report.caps.privateApi).toBe(false);
      expect(getCaps().privateApi).toBe(false);
    } finally {
      await handle.stop();
    }
  });
});

describe('full round-trip through the booted worker', () => {
  it('sends outbound, suppresses the echo, and delivers a genuine inbound message', async () => {
    bb.state.privateApi = true;
    bb.state.helperConnected = true;
    bb.state.newChatGuid = 'iMessage;-;e2e-roundtrip';

    const handle = await startServer(TEST_CONFIG);
    try {
      // 1. Outbound: agent sends to a fresh number -> exactly one /chat/new.
      await handle.app.handle(
        missiveWebhookRequest({
          message: {
            id: 'e2e-mo-1',
            type: 'custom_text',
            body: 'hello from the agent',
            to_fields: [{ id: '+15557770001' }],
            references: [],
          },
          conversation: { id: 'e2e-conv-1' },
        }),
      );
      await waitFor(() => bb.count('POST', '/chat/new') === 1, {
        timeoutMs: 6000,
        label: 'outbound chat/new',
      });

      // 2. Echo: BlueBubbles reports our own message back (isFromMe) with the
      //    real chat guid -> the worker must consume + drop it (no echo loop).
      await handle.app.handle(
        bbWebhookRequest({
          type: 'new-message',
          data: {
            guid: 'e2e-echo-1',
            text: 'hello from the agent',
            isFromMe: true,
            handle: null,
            chats: [{ guid: 'iMessage;-;e2e-roundtrip' }],
            dateCreated: Date.now(),
          },
        }),
      );
      await waitFor(() => pending() === 0, { timeoutMs: 6000, label: 'echo drained' });
      expect(missive.posts).toHaveLength(0); // echo NOT re-posted

      // 3. Inbound: a genuine reply from the contact -> one Missive message.
      await handle.app.handle(
        bbWebhookRequest({
          type: 'new-message',
          data: {
            guid: 'e2e-in-1',
            text: 'hi back!',
            isFromMe: false,
            handle: { address: '+15557770001' },
            chats: [{ guid: 'iMessage;-;e2e-roundtrip' }],
            dateCreated: Date.now(),
          },
        }),
      );
      await waitFor(() => missive.posts.length === 1, {
        timeoutMs: 6000,
        label: 'inbound posted',
      });

      const { messages } = missive.posts[0] as MissiveInboundBody;
      expect(messages.account).toBe(config.MISSIVE_ACCOUNT_ID);
      expect(messages.references).toEqual(['bb-chat-iMessage;-;e2e-roundtrip']);
      expect(messages.external_id).toBe('bb-msg-e2e-in-1');
      expect(messages.body).toBe('hi back!');
    } finally {
      await handle.stop();
    }
  });
});
