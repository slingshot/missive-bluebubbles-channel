# BlueBubbles ↔ Missive Custom-Channel Bridge

[![CI](https://github.com/slingshot/missive-bluebubbles-channel/actions/workflows/ci.yml/badge.svg)](https://github.com/slingshot/missive-bluebubbles-channel/actions/workflows/ci.yml)
[![coverage 100%](https://img.shields.io/badge/coverage-100%25-brightgreen)](https://github.com/slingshot/missive-bluebubbles-channel/actions/workflows/ci.yml)
[![runtime: Bun 1.3](https://img.shields.io/badge/runtime-Bun%201.3-black?logo=bun)](https://bun.sh)

A single **Bun + Elysia + TypeScript** service that makes a self-hosted
[BlueBubbles](https://bluebubbles.app) iMessage server appear as a first-class
**custom channel** inside [Missive](https://missiveapp.com) — bidirectionally,
without echo loops or duplicates.

- An agent in Missive texts a phone number → it sends via **iMessage** (or SMS).
- An incoming iMessage (text, photo, tapback, edit/unsend, group event) appears
  **threaded in the right Missive conversation**.

The two systems share no conversation id, no identity shape, and no threading
model. This bridge *mints* the missing mapping in `bun:sqlite`, translates each
side's payloads, and hardens the seams (HMAC, atomic dedup, a durable outbox, a
real Missive rate limiter, a per-chat ordering barrier, consume-on-match echo
suppression) so delivery is reliable and effectively exactly-once.

> **Status: fully implemented.** The MVP text/attachment bridge plus every
> "Later" item — `updated-message` edit/unsend + tapback rendering, group-event
> system lines, identity name caching, `RECEIPTS_AS_POSTS` via the Missive Posts
> API, Private-API attachment upload + `message/multipart` mixed media, SMS
> availability detection + fallback, and the daily prune sweep. Every `src/*`
> module is at **100% line + function coverage** with no coverage-ignore pragmas.

---

## Table of contents

- [What it is](#what-it-is)
- [Architecture](#architecture)
- [The two message flows](#the-two-message-flows)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Creating the Missive custom channel (step by step)](#creating-the-missive-custom-channel-step-by-step)
- [Environment variables](#environment-variables)
- [Running it](#running-it)
- [Monitoring dashboard](#monitoring-dashboard)
- [Deployment notes](#deployment-notes)
  - [Run with Docker](#run-with-docker)
- [Feature matrix](#feature-matrix)
- [Known limitations & scope cuts](#known-limitations--scope-cuts)
- [Troubleshooting](#troubleshooting)
- [The 8 correctness invariants](#the-8-correctness-invariants)
- [Testing & coverage](#testing--coverage)
- [Conventions](#conventions)
- [Contributing](#contributing)

---

## What it is

Missive's **custom channels** are the supported extension point for piping a
third-party messaging system into Missive's shared inbox. Missive POSTs a
**signed webhook** when an agent sends, and exposes a REST endpoint to **inject**
incoming messages into a conversation. BlueBubbles exposes a REST API to send
iMessages and a webhook system that fires on new/updated messages, reactions,
typing, and group events.

This bridge is the glue between them: a single Bun process that verifies and
translates both directions, owns the conversation/identity mapping, and degrades
gracefully when the BlueBubbles **Private API** is unavailable.

---

## Architecture

One Bun process. `bun:sqlite` is the **source of truth** (mappings, dedup ledger,
durable outbox). The two webhook endpoints do *only* **verify → atomically
dedup + enqueue → ack 200** — they never touch the network, so they always ack
well within Missive's 15-second retry window. A background **worker** drains the
durable outbox and performs every side effect, governed by a real Missive rate
limiter and a per-chat head-of-line barrier. Pure mapping (`domain/*`) is kept
separate from I/O (`clients/*`) so every tricky transform is unit-testable with
no network.

```
                          ┌──────────────────────────────────────────────────┐
                          │                  BRIDGE (one Bun process)         │
                          │                                                    │
   Missive  ── HMAC ───▶  │  POST /missive/webhook ─┐                          │
 (agent send)            │   (parse:'none', raw     │                          │
                          │    HMAC, 401 on bad sig) │   ┌───────────────────┐ │
                          │                          ├──▶│  db.transaction:  │ │
   BlueBubbles ─ token ─▶ │  POST /bb/webhook/:token ┘   │  firstSeen()  +   │ │
 (incoming iMessage)     │   (constant-time guard)      │  outbox INSERT    │ │
                          │                              │  (atomic, #1)     │ │
                          │                              └─────────┬─────────┘ │
                          │                                        │ ack 200   │
                          │   ┌────────────────────────────────────▼────────┐ │
                          │   │ bun:sqlite  (WAL, busy_timeout, FK=ON)       │ │
                          │   │ chat_map · handle_map · message ·           │ │
                          │   │ sent_map · seen_events · outbox (leased)    │ │
                          │   └────────────────────────────────────┬────────┘ │
                          │                                        │ claim     │
                          │   ┌────────────────────────────────────▼────────┐ │
                          │   │ WORKER  (only place with side effects)       │ │
                          │   │  • per-chat barrier (head-of-line, #4)       │ │
                          │   │  • Missive token bucket (≤5 conc, ~1/s, 5/s) │ │
                          │   │  • echo consume-on-match (#5)                │ │
                          │   │  • retry: backoff+jitter / Retry-After       │ │
                          │   │  • domain/inbound · domain/outbound (PURE)   │ │
                          │   └──────┬───────────────────────────────┬───────┘ │
                          └──────────┼───────────────────────────────┼─────────┘
                                     │ POST /v1/messages             │ /message/text · /message/attachment
                                     │ (Bearer, base64 inline)       │ /chat/new · /message/multipart (PA)
                                     ▼                               ▼
                              Missive REST API               BlueBubbles REST API  ──▶  iMessage / SMS
```

### File layout

```
src/
  index.ts             # compose app; onStart (recover leases→ping→caps→self-register→worker+prune); listen
  config.ts            # the ONLY reader of process.env; validate + freeze; fail-fast on any problem
  logger.ts            # leveled JSON-line logs; redacts secret-keyed fields recursively
  util.ts              # verifyHmac, msToUnix, backoffMs, canonicalHash, bbDedupKey
  db.ts                # bun:sqlite: 6-table schema, PRAGMAs, leased outbox, echo + post ledgers
  types.ts             # the shared runtime-free type contract
  routes/
    missive-webhook.ts # POST /missive/webhook   (parse:'none' → raw HMAC → tx → 200; barrier key)
    bb-webhook.ts      # POST /bb/webhook/:token  (token guard → tx → 200; ephemeral throttle)
    health.ts          # GET /health, GET /
    dashboard.ts       # GET /dashboard/:token (+ /stats, POST retry) — optional, token-guarded
  clients/
    missive.ts         # callMissive (429 Retry-After), postInboundMessage, postConversationComment
    bluebubbles.ts     # bb() url builder; send/query/download/webhook/(PA) react·edit·upload·multipart
  domain/
    inbound.ts         # PURE: BB event → Missive inbound post(s); tapback/edit/unsend/group render + packing
    outbound.ts        # PURE: Missive webhook → BB send plan; chatGuid resolution; dmChatGuid barrier key
    identity.ts        # address → display name (handle/query → contact/query, cached in handle_map)
    capability.ts      # detect Private-API caps (both flags); periodic re-probe; graceful default
  queue/
    outbox.ts          # dispatch/drain/worker (leasing + reentrancy guard); wires clients+domain+db
    ratelimiter.ts     # token bucket: ≤5 concurrent, ~1 req/s sustained, burst 5; honors Retry-After
test/                  # unit + integration + e2e.smoke (100% line + function coverage)
```

### Data model — `bun:sqlite` (6 tables)

| Table | Purpose |
|---|---|
| `chat_map(chat_guid PK, reference UNIQUE, conversation_id, subject, created_at)` | reply routing + Missive threading |
| `handle_map(address PK, name, updated_at)` | cached `from_field.name` for inbound |
| `message(bb_guid PK, chat_guid, text, is_from_me, created_at)` | resolve `guid→chatGuid`/target text for `updated-message` (no `chats[]`) and tapback snippets |
| `sent_map(temp_guid PK, chat_guid, missive_msg_id UNIQUE, bb_guid, text, echo_consumed, status, created_at)` | outbound idempotency + echo correlation |
| `seen_events(id PK, created_at)` | dedup ledger; `firstSeen()` = `INSERT OR IGNORE … .changes === 1` |
| `outbox(id PK, kind, chat_guid, payload JSON, attempts, next_at, status, lease_until, last_error, created_at)` | durable queue; `chat_guid` is load-bearing for the per-chat barrier |

Opened with `{ strict: true, create: true }`; PRAGMAs `journal_mode=WAL`,
`busy_timeout=5000`, `foreign_keys=ON`. A daily prune sweep bounds
`seen_events` / `message` / done `outbox` rows older than ~30 days. The clock is
injectable (`createDb(path, clock)` / `Db.setClock`) so timestamps and the echo
recency window are deterministic under test.

---

## The two message flows

### Flow A — Missive → BlueBubbles (an agent sends)

1. **`POST /missive/webhook`** with Elysia `parse:'none'`. Read the raw bytes
   (`Buffer.from(await request.arrayBuffer())`), compute
   `"sha256=" + HMAC_SHA256_hex(raw, MISSIVE_HMAC_SECRET)`, length-check, then
   `timingSafeEqual`. **`401` before `JSON.parse`** — the digest is never taken
   over re-serialized JSON.
2. `JSON.parse(raw)`; in **one `db.transaction`** mark `firstSeen("missive:"+id)`
   **and** insert a `bb_send` outbox job (invariant #1). Ack `200` immediately.
3. The worker dispatches `bb_send` → `domain/outbound.ts` (pure) resolves the
   target **chatGuid** and **exactly one** send op:
   - **(a)** `chat_map` by `conversation.id` → reply-known-chat;
   - **(b)** a `bb-chat-<guid>` token in `message.references[]` that resolves to a
     known chat → reply-by-reference;
   - **(c)** a single recipient whose existing 1:1 chat resolves → reply-known-chat;
   - **(d)** otherwise → **new conversation** (one recipient = 1:1; many = group,
     which requires the Private API).
   - **Known chat:** `recordSend(tempGuid, …)` **then** one `/message/text` or
     `/message/attachment`. **New conversation:** exactly one `/chat/new` carrying
     the body (never *also* `/message/text` — invariant #3).
4. The send response `guid` is stored in `sent_map.bb_guid`; the learned Missive
   `conversation.id` is bound onto the chat (invariant #6). A later
   `message-send-error` for our temp/guid marks the row `failed`.

### Flow B — BlueBubbles → Missive (an incoming iMessage)

1. **`POST /bb/webhook/:token`** — constant-time token compare (`404` on
   mismatch). In one `db.transaction`, `firstSeen(dedupKey)` + enqueue a
   `missive_post` job. Dedup keys are **per event class** (invariant #2): new
   messages/tapbacks by `guid`; `updated-message` by a generation key
   (`delivered/read/edited/retracted`); guid-less events by `canonicalHash`;
   typing/read-status are ephemeral (throttled in-memory, never persisted).
2. The worker dispatches `missive_post` → branch on `type`:

   | event | action |
   |---|---|
   | `new-message` | cache message; if `isFromMe` and it matches a recent send → **echo, drop** (#5); tapback → render `"X loved …"`; else build Missive post(s) |
   | `updated-message` | resolve chat via the `message` table; `dateEdited` → `✏️ Edited: …`; `dateRetracted` → `🚫 Unsent`; delivered/read → no-op (or a Posts comment when `RECEIPTS_AS_POSTS`) |
   | `message-send-error` | mark the matching `sent_map` row `failed` |
   | `group-*` / `participant-*` | update `chat_map.subject`; post a system line |
   | `typing-indicator` / `chat-read-status-changed` | drop (typing); read-status only when `RECEIPTS_AS_POSTS` |
3. **Build the Missive POST(s):** `references=["bb-chat-<chatGuid>"]` on every
   post; `external_id="bb-msg-<guid>"` (with `:text`/`:att<n>` suffixes when one
   BB message splits across posts); `conversation=<chat_map.conversation_id>` when
   known (#6); `from_field` from cached identity, `to_fields=[SELF]`. Attachments
   are downloaded from BlueBubbles, base64-inlined, and **packed** into as few
   POSTs as fit under `MISSIVE_MAX_PAYLOAD_BYTES`; a single file over the cap
   becomes a `📎 … — too large to inline` placeholder line.

---

## Prerequisites

- **[Bun](https://bun.sh) ≥ 1.1** (the runtime, test runner, and bundler;
  `bun:sqlite` is built in — no native module to compile). Install with
  `curl -fsSL https://bun.sh/install | bash`.
- **A running BlueBubbles server** with its **REST API enabled** and a
  **password** set. It can run on the **same Mac** as the bridge or on a
  **remote** Mac reachable over the network — both are supported via `BB_URL` /
  `BB_PASSWORD`. (Private-API features additionally require the BlueBubbles
  helper bundle; the bridge auto-detects and degrades without it.)
- **A Missive organization on the Productive plan** (custom channels are a
  Productive-plan feature), with permission to create an integration / custom
  channel and a **personal access token** (`Missive → Settings → API`).
- **A public HTTPS URL** that reaches the bridge (`PUBLIC_URL`). For a local
  bridge, a tunnel (Cloudflare Tunnel, ngrok, Tailscale Funnel) is the easy path
  — see [Deployment notes](#deployment-notes).

---

## Setup

```bash
bun install
cp .env.example .env     # then fill in the required values
```

Generate the two secrets the bridge needs you to invent:

```bash
openssl rand -hex 24     # BB_HOOK_TOKEN (guards the unsigned BlueBubbles webhook; needs ≥32 chars)
```

(The Missive HMAC secret is **chosen by you in the Missive channel UI** and then
copied into `MISSIVE_HMAC_SECRET` — see the next section.)

Config is validated and **frozen at boot**: a single startup aggregates *every*
problem (missing required key, non-URL `BB_URL`, a `BB_HOOK_TOKEN` under 32
chars, a bad enum) into one error message, so you fix them all at once.

---

## Creating the Missive custom channel (step by step)

Do this in Missive first so you have the **HMAC secret** and **Account ID** to
put in `.env`.

1. In Missive, open **Settings → Integrations → Custom Channels → Add**
   (Productive plan required).
2. **Type:** choose **Text** (this channel carries plain text + attachments).
3. **Enable outgoing messages.** This is what makes Missive POST the signed
   webhook to the bridge when an agent sends. (Without it, only inbound works.)
4. **Fields:** enable a **recipient** field and a **sender** field so agents can
   address a phone number/email and pick the channel alias. The recipient
   becomes the webhook's `to_fields[]` (who to text); the sender becomes
   `from_field` (the channel alias).
5. **Webhook URL:** set it to **`<PUBLIC_URL>/missive/webhook`** — e.g.
   `https://bridge.example.com/missive/webhook`. This must be the bridge's public
   HTTPS base + `/missive/webhook`. (The *BlueBubbles* webhook is a different URL
   that the bridge registers automatically; you don't enter that one here.)
6. **HMAC / signing secret:** set a strong shared secret (e.g.
   `openssl rand -hex 32`). Copy it verbatim into `MISSIVE_HMAC_SECRET`. The
   bridge verifies `X-Hook-Signature: sha256=…` over the **raw** request body and
   returns `401` on any mismatch.
7. **Save**, then open the channel's settings and **copy its Account ID** (the
   channel id). Paste it into `MISSIVE_ACCOUNT_ID` — it is the **required**
   `account` field on every inbound message the bridge injects.

After boot, send a test text from Missive and a test iMessage inbound; confirm
`/health` reports `ready: true` and the message lands threaded.

---

## Environment variables

The bridge reads `process.env` in exactly one module (`src/config.ts`), validates
it, and freezes it. **Required** keys must be present and non-empty.

### Required

| Variable | Description |
|---|---|
| `BB_URL` | BlueBubbles base URL, no trailing slash (REST base is `<BB_URL>/api/v1`). Local or remote. |
| `BB_PASSWORD` | BlueBubbles server password (sent as `?password=…` on every BB call). Never logged. |
| `MISSIVE_TOKEN` | Missive personal access token (`missive_pat-…`); sent as `Authorization: Bearer`. |
| `MISSIVE_ACCOUNT_ID` | The custom-channel id — required `account` on every inbound POST. Copied from the channel UI. |
| `MISSIVE_HMAC_SECRET` | The channel's signing secret; the bridge verifies `X-Hook-Signature` on raw bytes. |
| `PUBLIC_URL` | The bridge's own public HTTPS base, no trailing slash. Used to build the BB webhook target. Never derived from a request host. |
| `BB_HOOK_TOKEN` | **≥32 random chars** guarding the unsigned BlueBubbles webhook path. `openssl rand -hex 24`. |
| `SELF_HANDLE` | The Mac's own iMessage address (phone/email); used as inbound `to_fields[0]`. |

### Optional (defaults shown)

| Variable | Default | Description |
|---|---|---|
| `SELF_NAME` | `Me` | Display name for the bridge's own identity (self-from-other-device posts). |
| `PORT` | `3000` | HTTP port the bridge listens on. |
| `DB_PATH` | `./data/bridge.sqlite` | SQLite file path (source of truth). |
| `DEFAULT_SERVICE` | `iMessage` | Service for brand-new outbound conversations (`iMessage` or `SMS`). |
| `ATTACHMENT_ORIGINAL` | `false` | `false` requests `?original=false` so BlueBubbles transcodes HEIC→JPEG / caf→mp3 for previewability. |
| `MISSIVE_MAX_PAYLOAD_BYTES` | `9500000` | Hard cap for one inbound POST body (base64 inflates ~33%; whole JSON must stay ≤10 MB). Drives packing/splitting. |
| `RECEIPTS_AS_POSTS` | `false` | If `true`, surface delivered/read receipts as Missive Posts comments. |
| `CAPS_REPROBE_MS` | `300000` | Interval (ms) for re-probing BlueBubbles Private-API capability. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `DASHBOARD_TOKEN` | *(unset)* | Optional **≥32-char** token enabling the [monitoring dashboard](#monitoring-dashboard) at `/dashboard/<token>`. Unset disables it (routes 404). `openssl rand -hex 24`. |

---

## Running it

| Script | Command | What it does |
|---|---|---|
| `bun run dev` | `bun --watch src/index.ts` | Run with hot reload. |
| `bun run start` | `bun src/index.ts` | Run for production. |
| `bun run typecheck` | `tsc --noEmit` | Strict type-check (ESM bundler resolution). |
| `bun run test` | `bun test` | Full suite (coverage enforced to 100% via `bunfig.toml`). |
| `bun run test:cov` | `bun test --coverage` | Same, with the printed coverage table. |
| `bun run format` | `biome format --write .` | Format the codebase. |
| `bun run lint` | `biome check .` | Biome lint + assist checks. |

On boot the bridge runs a **non-fatal** sequence: recover any crash-orphaned
outbox leases → ping BlueBubbles → detect Private-API caps → **idempotently
self-register** its BlueBubbles webhook (`list → match exact URL → create if
absent`, so reboots never duplicate) → start the worker, the capability
re-probe, and the daily prune sweep. If BlueBubbles is down at boot, the bridge
**still starts**, still accepts Missive webhooks, and queues work; a background
probe completes registration once BlueBubbles is reachable. `GET /health` flips
`ready: true` only once ping + `server/info` + webhook registration all pass, and
also reports the cached caps (`privateApi`, the raw `helperConnected` flag, and
`lastProbeAt`), the pending outbox depth, and uptime.

---

## Monitoring dashboard

An optional, self-contained web dashboard served by the bridge itself — no extra
services, no build step. **Disabled by default**: it exists only when
`DASHBOARD_TOKEN` (≥32 random chars) is set, and every dashboard route answers
`404` otherwise, or on any token mismatch (constant-time compare, same guard as
the BlueBubbles webhook).

Open `https://<PUBLIC_URL>/dashboard/<DASHBOARD_TOKEN>` in a browser. The page
polls its stats endpoint every 5 s and shows: the `ready` flag and uptime,
Private-API + helper status with the age of the last successful probe, outbox
depth per status (`pending` / `claimed` / `done` / `dead` — `done` counts rows
still inside the 30-day retention window), 24-hour activity (inbound messages,
outbound sends, suppressed echoes), the Missive rate-limiter's in-flight count,
and the 20 newest **dead-lettered jobs** with their error and attempt count.

Endpoints (all under the token path):

| Endpoint | What it does |
|---|---|
| `GET /dashboard/<token>` | The HTML page (inline JS, no external assets). |
| `GET /dashboard/<token>/stats` | The JSON snapshot the page polls. Local SQLite reads only — no network I/O, safe to poll or script against. |
| `POST /dashboard/<token>/retry/<id>` | Flip a **dead** outbox job back to `pending` (attempts reset, due immediately). `409` if the job isn't dead, `404` if unknown. |

**Retrying is safe by construction:** an outbound resend reuses the stored
`tempGuid`, so BlueBubbles' `sendCache` dedups it (invariant #8), and each
inbound sub-post has its own delivery-ledger entry, so a partially-delivered
job only redoes what never landed (invariant #7).

**Security posture:** the token is the whole guard — treat the URL as a secret,
serve it only over HTTPS, and rotate by changing the env var. Dead-letter rows
expose `kind`, `chat_guid`, and the error string, but never message payloads.

---

## Deployment notes

- **`PUBLIC_URL` must be a real public HTTPS URL** reaching the bridge. Missive
  POSTs the outbound webhook to `<PUBLIC_URL>/missive/webhook`, and the bridge
  registers `<PUBLIC_URL>/bb/webhook/<BB_HOOK_TOKEN>` with BlueBubbles. It is
  **never** derived from a request host header (so a spoofed `Host` can't
  redirect webhooks).
- **Tunnel for local runs.** If the bridge runs on your Mac/laptop, expose it
  with a tunnel and point `PUBLIC_URL` at the tunnel hostname:
  - Cloudflare Tunnel — `cloudflared tunnel --url http://localhost:3000`
  - ngrok — `ngrok http 3000`
  - Tailscale Funnel — `tailscale funnel 3000`
- **Same-Mac vs remote BlueBubbles.** The bridge and BlueBubbles are decoupled by
  `BB_URL`/`BB_PASSWORD`:
  - **Same Mac:** point `BB_URL` at `http://localhost:<bb-port>` (default
    BlueBubbles port is `1234`). Lowest latency; only the bridge needs a public
    tunnel.
  - **Remote BlueBubbles:** point `BB_URL` at the remote server's reachable
    address (its own tunnel/LAN/VPN). The bridge calls *out* to BlueBubbles and
    BlueBubbles calls *back* to `<PUBLIC_URL>/bb/webhook/<token>`, so both hosts
    must be able to reach the other's URL.
- **Persistence.** `DB_PATH` is the durable source of truth (mappings, dedup,
  outbox). Put it on a persistent volume; WAL sidecar files (`*.sqlite-wal`,
  `*.sqlite-shm`) live next to it. The mid-flight outbox survives restarts —
  `requeueClaimed()` recovers leases on boot and the worker resumes draining.
- **Secrets.** `.env` is git-ignored. The logger redacts any secret-keyed field
  (`password`, `token`, `secret`, `authorization`, `base64`, …) recursively, so
  structured logs never leak credentials or attachment bytes.

### Run with Docker

A `Dockerfile` and `docker-compose.yml` ship in the repo. There is no build
step — the image is just Bun + production deps + `src/`, and `bun:sqlite` is part
of the runtime — so the image is single-stage and small. Compose defines **only
the bridge** (plus a persistent volume); the public HTTPS tunnel for `PUBLIC_URL`
stays external (see the tunnel options above).

```bash
cp .env.example .env        # fill in the required values
docker compose up -d --build
docker compose logs -f      # watch the boot sequence
curl localhost:3000/health  # { ready, caps, outboxDepth, uptimeMs }
```

- **BlueBubbles location.** Compose defaults `BB_URL` to
  `http://host.docker.internal:1234` so the container reaches a BlueBubbles server
  running on the **same host** (the `host.docker.internal:host-gateway` mapping
  makes this work on Linux too; it is a no-op on Docker Desktop). For a **remote**
  BlueBubbles server, set `BB_URL` in `.env` — it takes precedence over the default.
- **Persistence.** State lives in the named volume `bridge-data` mounted at
  `/app/data`; Compose pins `DB_PATH=/app/data/bridge.sqlite`. The SQLite file and
  its WAL sidecars survive `docker compose down` (they're removed only by
  `docker compose down -v`). The process runs as the non-root `bun` user.
- **Port.** `PORT` (default `3000`) sets both the listen port and the published
  host port. `.env` is never baked into the image (it's in `.dockerignore`); it is
  injected at runtime via `env_file`.

---

## Feature matrix

What works depends on whether the BlueBubbles **Private API** is available
(`GET /server/info` reports `private_api === true` **and**
`helper_connected === true`). The bridge auto-detects this on boot, re-probes
every `CAPS_REPROBE_MS`, and **never hard-fails a send** for a missing
capability — it strips the private-only path and falls back to apple-script text.

| Capability | Without Private API (apple-script) | With Private API |
|---|---|---|
| Outbound text → iMessage | ✅ `/message/text` | ✅ `/message/text` |
| Outbound to an existing 1:1 / threaded chat | ✅ | ✅ |
| Outbound **new 1:1** conversation | ✅ `/chat/new` | ✅ `/chat/new` |
| Outbound **group** creation (multiple recipients) | ❌ requires Private API | ✅ `/chat/new` (private-api) |
| Outbound single attachment | ✅ `/message/attachment` | ✅ |
| Outbound **caption + multiple attachments** as one message | ⚠️ split into N attachment sends + a text send (nothing dropped) | ✅ one `/message/multipart` (upload + mixed text/media) |
| Per-recipient **SMS fallback** on a new 1:1 (iMessage unavailable) | ❌ uses `DEFAULT_SERVICE` | ✅ availability probe → SMS |
| Inbound text / photo / video | ✅ | ✅ |
| Inbound **tapback** rendered as text (`"X loved …"`) | ✅ | ✅ |
| Inbound **edit / unsend** rendered (`✏️ Edited` / `🚫 Unsent`) | ✅ | ✅ |
| Inbound **group/participant** system lines + subject sync | ✅ | ✅ |
| Identity name caching (`handle/query → contact/query`) | ✅ | ✅ |
| Delivered/read receipts as Posts comments (`RECEIPTS_AS_POSTS`) | ✅ (read-status only when reported) | ✅ |
| Built-in monitoring dashboard + dead-letter retry (`DASHBOARD_TOKEN`) | ✅ | ✅ |
| **Outbound** reactions / edits / unsends | ❌ no Missive gesture maps to these (see scope cuts) | ❌ (clients exist but unreachable) |

The `clients/bluebubbles.ts` Private-API methods (`react`, `edit`, `unsend`,
`uploadAttachment`, `sendMultipart`) are all implemented; the reaction/edit/unsend
*outbound* paths are unreachable from Missive by design (see below).

---

## Known limitations & scope cuts

These are deliberate decisions carried from the design plan, not gaps:

- **No outbound reactions / edits / unsends.** Missive's custom-channel webhook
  only delivers `type:"custom_text"`; no agent gesture maps to a tapback/edit/
  unsend, so there's nothing to translate. (Inbound tapbacks/edits/unsends are
  still *rendered as text*.) The BlueBubbles `/react`, `/edit`, `/unsend` clients
  exist but are intentionally unreachable.
- **No threaded/quoted outbound replies.** The Missive webhook carries no
  target-iMessage reference, so a Missive "reply" is a normal send into the chat
  (`selectedMessageGuid` is reserved, unused).
- **No status patch into Missive.** Missive has no `PATCH /messages/:id`;
  `delivered_at` is set once at create time. Optional `RECEIPTS_AS_POSTS`
  surfaces delivered/read as Posts comments instead.
- **No inbound typing indicators, no avatars.** Missive custom channels expose
  neither; BlueBubbles typing (DM-only) is dropped.
- **Attachment 10 MB JSON cap.** Inbound attachments are packed/split to stay
  under the cap; a single oversized file becomes a placeholder line. No
  URL-hosted inbound attachments (Missive accepts only inline `base64_data`).
- **At-least-once inbound delivery.** Missive has no server-side `external_id`
  create-dedup, so a crash between a successful Missive POST and marking the row
  done can rarely re-post. The per-sub-post delivery ledger (#7) minimizes this;
  outbound is exactly-once-ish via tempGuid reuse + BlueBubbles `sendCache` (#8).
- **Outbound attachment shape is the one MED-confidence area.** The worker decodes
  `base64_data` when the Missive webhook carries it inline; verify against a live
  outbound webhook during your E2E pass (the design plan flags this and the
  `references`-presence question as the two things to confirm with real traffic).

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Boot throws `Invalid configuration:` | A required env var is missing/empty or malformed. The error lists **every** problem at once — fix them all and reboot. |
| Missive webhook returns `401` | HMAC mismatch: `MISSIVE_HMAC_SECRET` doesn't match the secret set in the channel UI, or a proxy is altering the raw body. The digest is over **raw bytes** — disable any body re-encoding in front of the bridge. |
| Outbound sends never leave Missive | Outgoing messages weren't enabled on the channel, or the webhook URL isn't `<PUBLIC_URL>/missive/webhook`, or the tunnel is down. Check `/health` and the channel's webhook config. |
| Inbound iMessages never appear | BlueBubbles can't reach `<PUBLIC_URL>/bb/webhook/<token>`. Confirm `/health` shows `ready: true` (webhook self-registered), that `BB_HOOK_TOKEN` matches, and that BlueBubbles can reach `PUBLIC_URL`. |
| `/health` stuck at `ready: false` | BlueBubbles is unreachable at boot. The bridge keeps queuing; check `BB_URL`/`BB_PASSWORD` and that the BlueBubbles REST API is on. It self-heals once reachable. |
| Group send fails | Creating a group conversation requires the Private API. `/health` `caps.privateApi` will be `false` if the helper isn't connected. |
| Photos arrive as `📎 … — too large to inline` | The file exceeds `MISSIVE_MAX_PAYLOAD_BYTES`. Raise it (staying under Missive's 10 MB JSON limit) or leave `ATTACHMENT_ORIGINAL=false` so HEIC/caf transcode smaller. |
| Agent's own sends double-post as inbound | Echo suppression depends on `sent_map`; if you wiped the DB mid-flight, in-flight echoes can't be matched. Steady-state this is handled by consume-on-match (#5). |
| Duplicate BlueBubbles webhooks after reboot | Shouldn't happen — registration is idempotent (`list → match exact URL`). If `PUBLIC_URL` changed, the old URL stays registered in BlueBubbles; remove it there. |

---

## The 8 correctness invariants

These are **requirements**, encoded in the foundation and enforced by tests:

1. **Atomic dedup+enqueue** — both webhook routes run `firstSeen` + the outbox
   insert in one `db.transaction` (`Db.dedupAndEnqueue`). Marking an event seen
   before the work is durable would lose it on a crash between the two writes.
2. **Type-correct dedup keys** — `util.bbDedupKey` never emits a
   `…:undefined:undefined` key; per-event-class scheme; ephemeral events return
   `null` (handled in-memory, never persisted).
3. **No double-send on new conversations** — exactly one BlueBubbles send path
   (`chat/new` *with* the body **xor** `message/text`); its `tempGuid` recorded.
4. **Don't assume `chat/new` is idempotent** — resolve an existing chat (by
   conversation id, by reference, or the deterministic DM guid) before creating.
5. **Echo suppression by consume-on-match** — `Db.consumeEcho` (atomic): exact
   `bb_guid` match, else the oldest unconsumed `sent_map` row by chat+text within
   ~5 min, marked consumed. Two identical messages consume two rows.
6. **Bind conversation id when known** — `references` always; `conversation` once
   `chat_map` has it (covers the agent-created-conversation-first case).
7. **Per-POST unique `external_id`** — a split BB message → N outbox jobs, each
   its own `external_id` suffix, gated by a per-sub-post delivery ledger so a
   retry re-posts only the unfinished sub-post.
8. **Outbound retry reuses the stored `tempGuid`** — BlueBubbles `sendCache`
   dedups the resend, so a crash-after-deliver never double-texts.

---

## Testing & coverage

`bunfig.toml` enforces **100% line + function coverage** (`coverageThreshold =
1.0`) with `text` + `lcov` reporters. The test environment is seeded by
`test/setup.ts` (Bun `preload`) so `config` validates cleanly and the singleton
DB runs in `:memory:`. External HTTP is mocked with a local `Bun.serve`, not by
monkeypatching global `fetch`.

```bash
bun run test:cov
```

```
 347 pass
 0 fail
 911 expect() calls
All files | 100.00 % Funcs | 100.00 % Lines
```

### Coverage notes

Every `src/*` module is at **100% line + function coverage** with **no
coverage-ignore pragmas**. The only path excluded from measurement is
`src/types.ts` — it is **runtime-free** (pure `type`/`interface` declarations that
compile to nothing), so it is excluded via `coveragePathIgnorePatterns` in
`bunfig.toml`. No executable line is ignored anywhere.

Coverage is *meaningful*, not vacuous — the wired "Later" features and the
high-risk concurrency paths are exercised through the integrated route → worker →
client system, with assertions that fail if the wiring is removed:

- **Outbox leasing + reentrancy** (`integration.test.ts`): overlapping
  `drainOutbox` passes never double-dispatch; `db.test.ts` proves the lease keeps
  the per-chat barrier closed against siblings and `requeueClaimed` recovers
  crash-orphaned leases.
- **No fork on concurrent new-conversation sends**: two first-contact sends to one
  number collapse to a single `chat/new` via the deterministic DM barrier key.
- **Reply-by-reference + existing-DM resolution** end to end (these caught a real
  double-parse bug where reply-by-reference silently forked a conversation).
- **Identity name caching, `RECEIPTS_AS_POSTS`, SMS fallback, Private-API
  multipart, the per-sub-post delivery ledger (#7), and `message-send-error`→
  `failed`** are each driven through the route/worker.

---

## Conventions

- Bun + Elysia + TypeScript, ESM, `tsc` strict (`noImplicitAny`,
  `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). No `any` in exported
  signatures — precise types come from `src/types.ts`.
- `node:crypto` for HMAC (`createHmac` + `timingSafeEqual`); `bun:sqlite` for the
  DB; Bun global `fetch`/`FormData`/`File` for HTTP. Every outbound `fetch`
  carries `AbortSignal.timeout()` so a hung BlueBubbles never stalls the worker.
- Pure functions in `domain/*`; I/O in `clients/*`; the worker (`queue/*`) is the
  **only** place that performs side effects. Secrets are never logged.
- The server bootstrap in `src/index.ts` is guarded by `import.meta.main`, so the
  module imports cleanly in tests without binding a port.

---

## Contributing

Contributors and AI agents: read **[`AGENTS.md`](AGENTS.md)** first — it covers the
architecture, the 8 correctness invariants, conventions, the local gate, and the
CI / Dependabot setup. (`CLAUDE.md` is a symlink to it.)

> **Every change must update the relevant documentation** — `README.md`,
> `AGENTS.md`, and `.env.example` (when config changes) — in the same PR. Changes
> that alter behavior or config without corresponding doc updates should not be
> merged. See the [Definition of Done](AGENTS.md#definition-of-done).
