/**
 * Monitoring dashboard route (optional).
 *
 * All three endpoints live under `/dashboard/:token` and are guarded by
 * `DASHBOARD_TOKEN` (constant-time compare, like the BlueBubbles webhook). A
 * `null` token disables the dashboard entirely — every route answers the same
 * `404` as a mismatch, so an unconfigured bridge reveals nothing.
 *
 * - `GET  /dashboard/:token`           — the self-contained HTML page (below).
 * - `GET  /dashboard/:token/stats`     — the JSON snapshot the page polls.
 *   Local SQLite reads + cached caps only — no network I/O, safe to poll.
 * - `POST /dashboard/:token/retry/:id` — flip a dead outbox job back to
 *   pending ({@link Db.retryDead}; safe per invariants #7/#8).
 *
 * The stats handler is deliberately branch-free: it returns raw facts (`now`,
 * `lastProbeAt`, counts) and leaves all conditional rendering to the page's
 * client-side JS, which the coverage gate does not measure.
 */

import { Elysia } from 'elysia';
import type { Db } from '../db.ts';
import type { Logger } from '../logger.ts';
import type { Caps, OutboxRow } from '../types.ts';
import { constantTimeEqual } from '../util.ts';

/** Cap on the dead-letter list in one stats snapshot (newest first). */
export const DEAD_JOBS_LIMIT = 20;

/** The 24-hour activity window, in ms. */
const DAY_MS = 86_400_000;

/** A dead outbox row projected for display — never includes `payload` (PII). */
export interface DeadJobSummary {
  readonly id: number;
  readonly kind: string;
  readonly chat_guid: string | null;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly created_at: number;
}

/** The JSON snapshot returned by `GET /dashboard/:token/stats`. */
export interface DashboardStats {
  readonly ready: boolean;
  readonly uptimeMs: number;
  readonly caps: Caps;
  readonly outbox: {
    readonly pending: number;
    readonly claimed: number;
    readonly done: number;
    readonly dead: number;
  };
  /** Newest first, at most {@link DEAD_JOBS_LIMIT}. */
  readonly deadJobs: readonly DeadJobSummary[];
  readonly activity24h: {
    readonly inbound: number;
    readonly outbound: number;
    readonly echoesSuppressed: number;
  };
  /** Live Missive rate-limiter in-flight permit count. */
  readonly missiveInFlight: number;
  /** Server clock (epoch ms) — the client derives probe/job ages from this. */
  readonly now: number;
}

/** Injected dependencies for the dashboard route. */
export interface DashboardDeps {
  /** Database (monitoring helpers + retry). */
  db: Db;
  /** Leveled logger. */
  logger: Logger;
  /** Current capability snapshot. */
  getCaps(): Caps;
  /** Whether boot self-registration has completed. */
  isReady(): boolean;
  /** Guard token; `null` disables the dashboard (every route 404s). */
  token: string | null;
  /** Live Missive limiter in-flight permit count. */
  missiveInFlight(): number;
}

/** Project a dead outbox row for display, dropping `payload` (may hold PII). */
function toDeadJobSummary(row: OutboxRow): DeadJobSummary {
  return {
    id: row.id,
    kind: row.kind,
    chat_guid: row.chat_guid,
    attempts: row.attempts,
    last_error: row.last_error,
    created_at: row.created_at,
  };
}

/** Build the Elysia plugin exposing the token-guarded dashboard endpoints. */
export function dashboardRoute(deps: DashboardDeps): Elysia {
  const { db, logger, getCaps, isReady, token, missiveInFlight } = deps;
  const startedAt = Date.now();

  /** Constant-time token guard; a `null` configured token never matches. */
  const authorized = (presented: string): boolean =>
    token !== null && constantTimeEqual(presented, token);

  const stats = (): DashboardStats => ({
    ready: isReady(),
    uptimeMs: Date.now() - startedAt,
    caps: getCaps(),
    outbox: db.outboxCounts(),
    deadJobs: db.listDeadJobs(DEAD_JOBS_LIMIT).map(toDeadJobSummary),
    activity24h: db.activitySince(db.now() - DAY_MS),
    missiveInFlight: missiveInFlight(),
    now: db.now(),
  });

  // Pin the declared contract type (exactOptionalPropertyTypes friction).
  return new Elysia()
    .get('/dashboard/:token', ({ params, status }) => {
      if (!authorized(params.token)) {
        logger.warn('dashboard rejected: bad token');
        return status(404, 'not found');
      }
      return new Response(DASHBOARD_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    })
    .get('/dashboard/:token/stats', ({ params, status }) => {
      if (!authorized(params.token)) {
        logger.warn('dashboard rejected: bad token');
        return status(404, 'not found');
      }
      return new Response(JSON.stringify(stats()), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    })
    .post('/dashboard/:token/retry/:id', ({ params, status }) => {
      if (!authorized(params.token)) {
        logger.warn('dashboard rejected: bad token');
        return status(404, 'not found');
      }
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) return status(404, 'not found');
      const outcome = db.retryDead(id);
      if (outcome === 'missing') return status(404, 'not found');
      if (outcome === 'not-dead') return status(409, 'not dead');
      logger.info('dead job retried', { id });
      return { ok: true, id };
    }) as unknown as Elysia;
}

/**
 * The dashboard page. One static template string with ZERO interpolation — the
 * token is never reflected into the body (the client derives its own URLs from
 * `location.pathname`). The inline client JS must contain no backslash, no
 * backtick, and no `${` (they would be consumed by THIS template literal), and
 * must render all dynamic values via `textContent` — `last_error` and other
 * payload-derived strings originate in external systems.
 */
const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'">
<title>Bridge dashboard</title>
<style>
  :root {
    --surface: #fcfcfb; --tile: #f3f3f1; --border: #e3e3e0;
    --ink: #1f1f1e; --muted: #6b6b69;
    --good: #0ca30c; --warning: #fab219; --critical: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface: #1a1a19; --tile: #242423; --border: #3a3a38;
      --ink: #e8e8e6; --muted: #a3a3a0;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 24px 20px 40px; max-width: 960px;
    background: var(--surface); color: var(--ink);
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
  h1 { font-size: 18px; font-weight: 600; margin: 0; }
  h2 {
    font-size: 12px; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.05em; margin: 28px 0 10px;
  }
  .badge { display: inline-flex; align-items: center; gap: 6px; font-weight: 500; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
  .dot.good { background: var(--good); }
  .dot.warning { background: var(--warning); }
  .dot.critical { background: var(--critical); }
  #banner {
    display: none; margin: 14px 0 0; padding: 8px 12px; border-radius: 6px;
    border: 1px solid var(--warning); font-weight: 500;
  }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .tile { background: var(--tile); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
  .tile .label { font-size: 12px; color: var(--muted); }
  .tile .value { font-size: 24px; font-weight: 600; margin-top: 2px; }
  .tile .note { font-size: 11px; color: var(--muted); margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; }
  td.num { font-variant-numeric: tabular-nums; }
  td.err { max-width: 320px; overflow-wrap: anywhere; color: var(--muted); }
  #empty-dead { color: var(--muted); padding: 10px 0; }
  button {
    font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--tile); color: var(--ink); cursor: pointer;
  }
  button:hover { border-color: var(--muted); }
  button:disabled { opacity: 0.5; cursor: default; }
  footer { margin-top: 26px; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>Bridge dashboard</h1>
  <span class="badge"><span id="ready-dot" class="dot"></span><span id="ready-label">loading</span></span>
</header>
<div id="banner">Disconnected from the bridge — retrying every 5 s</div>

<h2>Bridge</h2>
<div class="tiles">
  <div class="tile"><div class="label">Uptime</div><div id="uptime" class="value">—</div></div>
  <div class="tile"><div class="label">Private API</div>
    <div class="value badge"><span id="pa-dot" class="dot"></span><span id="pa-label">—</span></div>
    <div class="note badge"><span id="helper-dot" class="dot"></span><span id="helper-label">helper —</span></div>
  </div>
  <div class="tile"><div class="label">Last capability probe</div><div id="probe" class="value">—</div></div>
  <div class="tile"><div class="label">Missive in-flight</div>
    <div id="inflight" class="value">—</div><div class="note">of 5 concurrent</div></div>
</div>

<h2>Outbox</h2>
<div class="tiles">
  <div class="tile"><div class="label">Pending</div><div id="ob-pending" class="value">—</div></div>
  <div class="tile"><div class="label">Claimed</div><div id="ob-claimed" class="value">—</div></div>
  <div class="tile"><div class="label">Done</div><div id="ob-done" class="value">—</div>
    <div class="note">within 30-day retention</div></div>
  <div class="tile"><div class="label">Dead</div>
    <div class="value badge"><span id="dead-dot" class="dot" hidden></span><span id="ob-dead">—</span></div></div>
</div>

<h2>Activity (24 h)</h2>
<div class="tiles">
  <div class="tile"><div class="label">Inbound messages</div><div id="act-in" class="value">—</div></div>
  <div class="tile"><div class="label">Outbound sends</div><div id="act-out" class="value">—</div></div>
  <div class="tile"><div class="label">Echoes suppressed</div><div id="act-echo" class="value">—</div></div>
</div>

<h2>Dead letters</h2>
<div id="empty-dead" hidden>None — nothing has dead-lettered.</div>
<table id="dead-table" hidden>
  <thead><tr><th>Id</th><th>Kind</th><th>Chat</th><th>Attempts</th><th>Last error</th><th>Age</th><th></th></tr></thead>
  <tbody id="dead-body"></tbody>
</table>

<footer>Auto-refreshes every 5 s · <span id="updated">never updated</span></footer>

<script>
(function () {
  'use strict';
  var base = location.pathname;
  while (base.length > 1 && base.charAt(base.length - 1) === '/') base = base.slice(0, -1);

  function el(id) { return document.getElementById(id); }
  function text(id, value) { el(id).textContent = value; }

  function fmtDuration(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  function setDot(id, cls) {
    el(id).className = 'dot' + (cls ? ' ' + cls : '');
  }

  function render(stats) {
    el('banner').style.display = 'none';
    setDot('ready-dot', stats.ready ? 'good' : 'critical');
    text('ready-label', stats.ready ? 'Ready' : 'Not ready');
    text('uptime', fmtDuration(stats.uptimeMs));
    setDot('pa-dot', stats.caps.privateApi ? 'good' : 'warning');
    text('pa-label', stats.caps.privateApi ? 'on' : 'off');
    setDot('helper-dot', stats.caps.helperConnected ? 'good' : 'warning');
    text('helper-label', stats.caps.helperConnected ? 'helper connected' : 'helper disconnected');
    text('probe', stats.caps.lastProbeAt === 0 ? 'never' : fmtDuration(stats.now - stats.caps.lastProbeAt) + ' ago');
    text('inflight', String(stats.missiveInFlight));
    text('ob-pending', stats.outbox.pending.toLocaleString());
    text('ob-claimed', stats.outbox.claimed.toLocaleString());
    text('ob-done', stats.outbox.done.toLocaleString());
    text('ob-dead', stats.outbox.dead.toLocaleString());
    el('dead-dot').hidden = stats.outbox.dead === 0;
    setDot('dead-dot', 'critical');
    text('act-in', stats.activity24h.inbound.toLocaleString());
    text('act-out', stats.activity24h.outbound.toLocaleString());
    text('act-echo', stats.activity24h.echoesSuppressed.toLocaleString());
    renderDead(stats);
    text('updated', 'updated ' + new Date().toLocaleTimeString());
  }

  function retry(id, button) {
    button.disabled = true;
    button.textContent = 'retrying…';
    fetch(base + '/retry/' + id, { method: 'POST' })
      .then(function (res) {
        button.textContent = res.status === 200 ? 'retried' : res.status === 409 ? 'not dead' : 'error ' + res.status;
        load();
      })
      .catch(function () { button.textContent = 'failed'; button.disabled = false; });
  }

  function renderDead(stats) {
    var body = el('dead-body');
    while (body.firstChild) body.removeChild(body.firstChild);
    el('empty-dead').hidden = stats.deadJobs.length > 0;
    el('dead-table').hidden = stats.deadJobs.length === 0;
    stats.deadJobs.forEach(function (job) {
      var row = document.createElement('tr');
      var cells = [
        [String(job.id), 'num'],
        [job.kind, ''],
        [job.chat_guid === null ? '—' : job.chat_guid, 'err'],
        [String(job.attempts), 'num'],
        [job.last_error === null ? '—' : job.last_error, 'err'],
        [fmtDuration(stats.now - job.created_at), 'num'],
      ];
      cells.forEach(function (cell) {
        var td = document.createElement('td');
        td.textContent = cell[0];
        if (cell[1] !== '') td.className = cell[1];
        row.appendChild(td);
      });
      var actions = document.createElement('td');
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Retry';
      button.addEventListener('click', function () { retry(job.id, button); });
      actions.appendChild(button);
      row.appendChild(actions);
      body.appendChild(row);
    });
  }

  function load() {
    fetch(base + '/stats', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.json();
      })
      .then(render)
      .catch(function () { el('banner').style.display = 'block'; });
  }

  load();
  setInterval(load, 5000);
})();
</script>
</body>
</html>
`;
