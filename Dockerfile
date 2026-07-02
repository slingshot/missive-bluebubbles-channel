# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Runtime image for the BlueBubbles <-> Missive bridge.
#
# There is no build/compile step: Bun runs the TypeScript entrypoint directly
# and `bun:sqlite` is part of the runtime, so this is a single stage — just
# Bun + production deps + source. The whole durable state (mappings, dedup
# ledger, outbox) lives under /app/data, which MUST be a volume (see compose).
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.5-slim

WORKDIR /app

# Install ONLY production deps (drops biome/tsc/@types — unused at runtime) in a
# dedicated layer so it is cached until the manifest or lockfile changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Application source. Copied after deps so code edits don't bust the deps layer.
COPY src ./src

# Pre-create the state dir and hand it to the image's non-root `bun` user. A
# named volume mounted here on first run inherits this ownership, so the process
# (running as `bun`, not root) can create the SQLite file + WAL sidecars.
RUN mkdir -p /app/data && chown -R bun:bun /app/data
USER bun

# DB_PATH points at the volume; PORT is the port the bridge listens on. Both can
# be overridden at runtime (compose passes the rest of the config via env_file).
ENV DB_PATH=/app/data/bridge.sqlite \
    PORT=3000

EXPOSE 3000

# Liveness probe: /health always returns 200 once the server is listening (the
# `ready` flag lives in the body, not the status). The slim image has no curl,
# so we use Bun itself; a non-2xx/connect failure exits non-zero => unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "src/index.ts"]
