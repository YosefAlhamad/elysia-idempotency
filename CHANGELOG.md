# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-25

### Added

- `idempotency` Elysia plugin: a retried request with the same `Idempotency-Key` returns the original response with `Idempotent-Replayed: true` instead of running the handler again.
- Typed `ctx.idempotency` outcome, and `400`, `409`, `422`, and `503` rejections following the IETF Idempotency-Key header draft, with `Retry-After` on `409` and `503`.
- Request fingerprinting (method, path with query, and body, hashed as a stream), so a reused key with a different request gets `422`.
- Identity scoping by `Authorization` header or client IP by default, with a custom `identity` option, so records never cross clients.
- Options: `store`, `prefix`, `retention`, `lockTimeout`, `header`, `methods`, `required`, `fingerprint`, `identity`, `trustProxy`, `ipv6Subnet`, `maxBodyBytes`, `shouldStore`, `excludeHeaders`, `failureMode` (default `'closed'`), `onRejected`, `scope`, and `clock`.
- Thrown errors and 5xx responses release the key so retries run again; `401`, `403`, `408`, `409`, `425`, and `429` are never stored.
- `IdempotencyEngine` class for use outside Elysia, with `begin`, `complete`, `release`, and `close`.
- `MemoryStore` with TTL expiry, `maxKeys` and `maxBytes` caps that never evict live records, and a background sweep.
- `RedisStore` with an optimistic compare-and-set Lua script, per-key queueing, and `EVALSHA` caching. Works with Bun's `RedisClient`, ioredis, and node-redis.
- SHA-256 hashed store keys, Zod-validated stored records, and `Set-Cookie`, auth, and hop-by-hop headers never stored or replayed.
- Zod-validated options with exported schemas and `IdempotencyConfigError` messages that name each bad field.
