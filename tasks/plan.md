# Implementation Plan: Stage 0 — Shared Infrastructure

## Overview

Add production-grade shared infrastructure (Neon service database + Redis) to the scrapy-api service so developer-platform state (API keys, tiers, credit balances, metering counters) has a durable home. The existing scraper-owned PostgreSQL (read-only catalog) remains untouched. This is Stage 0 of 6 and builds the foundation used by all subsequent stages.

## Architecture Decisions

- **Dual-database architecture**: Keep the existing catalog pool (read-only, scraper-owned) separate from the new service pool (read/write, scrapy-api-owned). Application code must never write to the catalog pool and never read platform state from it.
- **Connection pooling**: Use the existing `createPool` factory pattern for the service database, with configurable pool size appropriate for Neon free tier.
- **Redis client**: Use `ioredis` (industry standard) for rate-limit counters and caching.
- **Health checks**: Extend existing `/health/ready` endpoint to check both databases and Redis, returning 503 with `Retry-After: 5` when any dependency is unavailable.
- **Startup validation**: Fail fast at startup if Neon service DB or Redis is unreachable.
- **Testing**: **No Redis in tests for now** — mock Redis client for unit tests; integration tests skip Redis (future work when needed).
- **Migration strategy**: Add a simple migration script (`scripts/migrate.ts`) that applies `schema.sql` to the service database. Run manually via `npm run migrate`.
- **Configuration validation**: Extend existing `config.ts` pattern with new required variables (`SERVICE_DATABASE_URL`, `REDIS_URL`, `API_KEY_PEPPER`).

## Task List

### Phase 1: Configuration & Validation

- [x] **Task 1: Extend configuration with new required variables**
  - Add `SERVICE_DATABASE_URL`, `REDIS_URL`, `API_KEY_PEPPER` to `AppConfig` interface
  - Update `loadConfig()` to validate and parse new variables
  - Add validation for Redis URL format and API_KEY_PEPPER minimum length
  - Update `.env.example` with new variables

- [x] **Task 2: Create service database pool factory**
  - Add `createServicePool()` function in `src/db/pool.ts` (or new `service-pool.ts`)
  - Reuse existing pool configuration patterns (SSL, timeouts, connection limits)
  - Configure pool size appropriate for Neon free tier (max: 4)

### Phase 2: Database Schema & Service Layer

- [x] **Task 3: Create service database schema types**
  - Define TypeScript interfaces for: `User`, `ApiKey`, `Tier`, `CreditBalance`, `CreditTransaction`
  - Create `src/db/service/types.ts` for shared types
  - Define `ServiceStore` interface mirroring `CatalogStore` pattern

- [x] **Task 4: Implement service database schema (SQL)**
  - Create `src/db/service/schema.sql` with all tables from spec:
    - `users`, `api_keys`, `tiers`, `credit_balances`, `credit_transactions`
    - Indexes and constraints as specified
    - Seed data for tiers
  - Include reserved columns for `api_key_restrictions` (unused until future feature)

- [x] **Task 5: Create service store implementation**
  - Implement `PgServiceStore` class in `src/db/service/store.ts`
  - Follow `PgCatalog` pattern with `withSnapshot()` method
  - Provide basic CRUD operations for platform tables
  - Handle connection lifecycle and error mapping

### Phase 3: Redis Integration

- [x] **Task 6: Add Redis client and connection management**
  - Add `ioredis` dependency
  - Create `src/db/redis.ts` with `createRedisClient()` function
  - Implement connection validation at startup
  - Export `RedisClient` type for dependency injection

### Phase 4: Health Checks & Startup Validation

- [x] **Task 7: Extend health check to verify all dependencies**
  - Update `readyCheck` in `src/server.ts` to check:
    - Catalog DB (`SELECT 1`)
    - Service DB (`SELECT 1`)
    - Redis (`PING`)
  - Return 503 with `Retry-After: 5` when any check fails
  - Update `registerReady` in `src/routes/health.ts` if needed

- [x] **Task 8: Add startup validation for service DB and Redis**
  - Modify `src/server.ts` to validate service DB and Redis connectivity on startup
  - Fail loudly (exit with error) if either is unreachable
  - Log clear error messages for each failure case

### Phase 5: Wiring & Integration

- [x] **Task 9: Wire service store and Redis into app**
  - Update `BuildAppOptions` interface in `src/app.ts` to accept optional `serviceStore` and `redis`
  - Pass service store and Redis through to routes that need them (future stages)
  - Update `src/server.ts` to create and pass service pool, service store, and Redis client

### Phase 6: Testing

- [x] **Task 10: Unit tests for configuration validation**
  - Test new config variables in `test/unit/config.test.ts`
  - Test validation of `SERVICE_DATABASE_URL`, `REDIS_URL`, `API_KEY_PEPPER`
  - Test missing/invalid cases

- [x] **Task 11: Unit tests for pool factories**
  - Test `createServicePool()` in `test/unit/pool.test.ts` (or new test file)
  - Test SSL configuration for remote Neon
  - Test pool options

- [x] **Task 12: Unit tests for Redis client**
  - Test `createRedisClient()` in `test/unit/redis.test.ts`
  - Test connection validation

- [x] **Task 13: Contract tests for health endpoint**
  - Test `/health/ready` returns 200 when all deps healthy
  - Test `/health/ready` returns 503 with `Retry-After: 5` when any dep fails
  - Add to `test/contract/` or `test/unit/health.test.ts`

- [x] **Task 14: Integration tests with test databases**
  - Create `test/integration/service-db.test.ts` using disposable test database pattern
  - Test service store CRUD operations
  - Test health check integration with real dependencies
  - Follow existing `postgres-server.ts` pattern

### Checkpoint: Foundation Complete
- [x] All tests pass (`npm test`)
- [x] Build succeeds (`npm run build`)
- [x] Type checking passes (`npm run typecheck`)
- [x] Linting passes (`npm run lint`)
- [x] Manual verification: health endpoint returns 200 with all deps available

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Neon free tier connection limits | High | Configure pool size conservatively (max: 4), monitor usage |
| Migration script failures | Medium | Idempotent script; test against local Postgres; document rollback |
| Redis connection failures in CI | Low | **No Redis in tests**; mock for unit tests; integration tests skip Redis |
| Dual-database confusion | Medium | Strict naming (`catalog` vs `service`), code reviews, clear interfaces |
| Health check false negatives | Low | Add retry logic, appropriate timeouts, detailed logging |

## Open Questions (Resolved)

1. **Migration strategy**: **Add a simple migration script** (`scripts/migrate.ts`) that applies `schema.sql` to the service database. Run manually via `npm run migrate`.
2. **Connection pool sizing**: **Use free tier default** (max: 4, matching existing `createPool` factory). Neon free tier has similar limits.
3. **Redis in CI**: **No Redis in tests for now** — mock Redis client for unit tests; integration tests skip Redis entirely (future work when Redis-dependent features are built).
4. **API_KEY_PEPPER**: **Read from env** (`API_KEY_PEPPER`) — user will provide; no generation script needed.