## Summary

<!-- What does this PR change, and why? -->

## Changes

-

## Checklist

- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes (Biome — lint + format)
- [ ] `bun test --coverage` passes at **100%** line + function coverage
- [ ] Updated `README.md` / `.env.example` if behavior or config changed
- [ ] Re-checked the affected [correctness invariants](../README.md#the-8-correctness-invariants) — HMAC raw-body verify, atomic dedup+enqueue, per-event dedup keys, per-chat ordering barrier, Missive rate limiter, single outbound send path, echo-loop suppression, per-POST `external_id`

## Verification

<!-- How was this tested? Paste relevant command output (CI will also post a coverage comment below). -->
