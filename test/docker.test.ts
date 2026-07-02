/**
 * Docker packaging contract.
 *
 * These are static "text contract" checks over the Dockerfile, compose file, and
 * .dockerignore — they read the files, they do NOT invoke the Docker daemon, so
 * they run in the normal `bun test` suite without needing Docker in CI. They
 * guard the invariants that are easy to silently break: the image Bun version
 * tracking the CI-pinned Bun, state living on the volume (never in the image),
 * secrets/state staying out of the build context, and the process not running as
 * root. If any of those drift, one of these fails loudly.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/** Read a repo-root-relative file as UTF-8 text. */
const read = (relPath: string): string =>
  readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8');

const dockerfile = read('Dockerfile');
const compose = read('docker-compose.yml');
const dockerignore = read('.dockerignore');
const ciWorkflow = read('.github/workflows/ci.yml');

describe('Dockerfile — base image', () => {
  test('pins a concrete oven/bun slim tag (never a floating tag)', () => {
    const from = dockerfile.match(/^FROM\s+oven\/bun:(\S+)/m);
    expect(from).not.toBeNull();
    const tag = from![1];
    expect(tag).not.toBe('latest');
    expect(tag).toMatch(/^\d+\.\d+\.\d+-slim$/);
  });

  test('image Bun version matches the CI-pinned Bun version', () => {
    const imageVersion = dockerfile.match(/oven\/bun:(\d+\.\d+\.\d+)/)?.[1];
    const ciVersion = ciWorkflow.match(/bun-version:\s*(\d+\.\d+\.\d+)/)?.[1];
    expect(imageVersion).toBeDefined();
    expect(ciVersion).toBeDefined();
    // Drift guard: bump one Bun pin and this fails until the other matches.
    expect(imageVersion).toBe(ciVersion);
  });

  test('installs only production deps from the frozen lockfile', () => {
    expect(dockerfile).toContain('bun install --frozen-lockfile --production');
  });

  test('runs as the non-root bun user', () => {
    expect(dockerfile).toMatch(/^USER\s+bun\s*$/m);
  });
});

describe('State persistence wiring', () => {
  test('DB_PATH lives under /app/data in the image and is pinned in compose', () => {
    expect(dockerfile).toMatch(/ENV[\s\S]*DB_PATH=\/app\/data\/bridge\.sqlite/);
    expect(compose).toMatch(/DB_PATH:\s*\/app\/data\/bridge\.sqlite/);
  });

  test('compose mounts a named volume at the same /app/data directory', () => {
    expect(compose).toMatch(/bridge-data:\/app\/data/);
    // The named volume must be declared at the top level, not just referenced.
    expect(compose).toMatch(/^volumes:\s*$/m);
    expect(compose).toMatch(/^\s{2}bridge-data:\s*$/m);
  });
});

describe('.dockerignore keeps secrets and state out of the image', () => {
  test.each(['.env', 'data/', 'node_modules/', '*.sqlite'])('excludes %s', (pattern) => {
    expect(dockerignore).toContain(pattern);
  });
});

describe('docker-compose', () => {
  test('loads config from .env via env_file', () => {
    expect(compose).toMatch(/env_file:/);
    expect(compose).toMatch(/-\s*\.env\b/);
  });

  test('defaults BB_URL to the host gateway but lets .env override it', () => {
    // Regex (not a string literal) so the `${...}` isn't flagged as a stray placeholder.
    expect(compose).toMatch(/\$\{BB_URL:-http:\/\/host\.docker\.internal:1234\}/);
    expect(compose).toContain('host.docker.internal:host-gateway');
  });
});
