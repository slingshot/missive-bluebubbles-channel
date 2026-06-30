/**
 * Test preload: populate a valid environment BEFORE any module (notably
 * `src/config.ts`, which validates at import) is loaded. `??=` is used so an
 * explicitly-exported env var still wins. `:memory:` keeps the singleton DB
 * off disk.
 *
 * Wired via `bunfig.toml` `[test] preload`. Excluded from coverage.
 */

process.env.BB_URL ??= 'http://localhost:1234';
process.env.BB_PASSWORD ??= 'test-password';
process.env.MISSIVE_TOKEN ??= 'missive_pat-test';
process.env.MISSIVE_ACCOUNT_ID ??= 'acct-test-0001';
process.env.MISSIVE_HMAC_SECRET ??= 'test-hmac-secret-value';
process.env.PUBLIC_URL ??= 'https://bridge.test';
process.env.BB_HOOK_TOKEN ??= 'test-hook-token-0123456789abcdef0123';
process.env.SELF_HANDLE ??= '+15555550100';
process.env.DB_PATH ??= ':memory:';
process.env.LOG_LEVEL ??= 'debug';
