# Stage 0 — Shared Infrastructure Task List

## Phase 1: Configuration & Validation

- [x] **Task 1: Extend configuration with new required variables**
  - Add `SERVICE_DATABASE_URL`, `REDIS_URL`, `API_KEY_PEPPER` to `AppConfig` interface
  - Update `loadConfig()` to validate and parse new variables
  - Add validation for Redis URL format and API_KEY_PEPPER minimum length
  - Update `.env.example` with new variables
  - **Files:** `src/config.ts`, `.env.example`
  - **Tests:** `test/unit/config.test.ts`

- [x] **Task 2: Create service database pool factory**
  - Add `createServicePool()` function in `src/db/pool.ts` (or new `service-pool.ts`)
  - Reuse existing pool configuration patterns (SSL, timeouts, connection limits)
  - Configure pool size appropriate for Neon free tier (max: 4)
  - **Files:** `src/db/pool.ts`
  - **Tests:** `test/unit/pool.test.ts`

## Phase 2: Database Schema & Service Layer

- [x] **Task 3: Create service database schema types**
  - Define TypeScript interfaces for: `User`, `ApiKey`, `Tier`, `CreditBalance`, `CreditTransaction`
  - Create `src/db/service/types.ts` for shared types
  - Define `ServiceStore` interface mirroring `CatalogStore` pattern
  - **Files:** `src/db/service/types.ts`
  - **Tests:** None (types only)

- [x] **Task 4: Implement service database schema (SQL)**
  - Create `src/db/service/schema.sql` with all tables from spec:
    - `users`, `api_keys`, `tiers`, `credit_balances`, `credit_transactions`
    - Indexes and constraints as specified
    - Seed data for tiers
  - Include reserved columns for `api_key_restrictions` (unused until future feature)
  - **Files:** `src/db/service/schema.sql`
  - **Tests:** None (SQL file)

- [x] **Task 4b: Create migration script**
  - Add `scripts/migrate.ts` that reads `schema.sql` and executes against `SERVICE_DATABASE_URL`
  - Add `npm run migrate` script to package.json
  - Script should be idempotent (safe to run multiple times)
  - **Files:** `scripts/migrate.ts`, `package.json`
  - **Tests:** Manual verification

- [x] **Task 5: Create service store implementation**
  - Implement `PgServiceStore` class in `src/db/service/store.ts`
  - Follow `PgCatalog` pattern with `withSnapshot()` method
  - Provide basic CRUD operations for platform tables
  - Handle connection lifecycle and error mapping
  - **Files:** `src/db/service/store.ts`
  - **Tests:** `test/integration/service-db.test.ts`

## Phase 3: Redis Integration

- [x] **Task 6: Add Redis client and connection management**
  - Add `ioredis` dependency
  - Create `src/db/redis.ts` with `createRedisClient()` function
  - Implement connection validation at startup
  - Export `RedisClient` type for dependency injection
  - **No Redis in tests** — mock Redis client for unit tests; integration tests skip Redis (future work)
  - **Files:** `src/db/redis.ts`, `package.json`
  - **Tests:** `test/unit/redis.test.ts` (mocked)

## Phase 4: Health Checks & Startup Validation

- [x] **Task 7: Extend health check to verify all dependencies**
  - Update `readyCheck` in `src/server.ts` to check:
    - Catalog DB (`SELECT 1`)
    - Service DB (`SELECT 1`)
    - Redis (`PING`)
  - Return 503 with `Retry-After: 5` when any check fails
  - Update `registerReady` in `src/routes/health.ts` if needed
  - **Files:** `src/server.ts`, `src/routes/health.ts`
  - **Tests:** `test/unit/health.test.ts` or `test/contract/health.test.ts`

- [x] **Task 8: Add startup validation for service DB and Redis**
  - Modify `src/server.ts` to validate service DB and Redis connectivity on startup
  - Fail loudly (exit with error) if either is unreachable
  - Log clear error messages for each failure case
  - **Files:** `src/server.ts`
  - **Tests:** Manual verification

## Phase 5: Wiring & Integration

- [x] **Task 9: Wire service store and Redis into app**
  - Update `BuildAppOptions` interface in `src/app.ts` to accept optional `serviceStore` and `redis`
  - Pass service store and Redis through to routes that need them (future stages)
  - Update `src/server.ts` to create and pass service pool, service store, and Redis client
  - **Files:** `src/app.ts`, `src/server.ts`
  - **Tests:** `test/unit/health.test.ts` (integration)

## Phase 6: Testing

- [x] **Task 10: Unit tests for configuration validation**
  - Test new config variables in `test/unit/config.test.ts`
  - Test validation of `SERVICE_DATABASE_URL`, `REDIS_URL`, `API_KEY_PEPPER`
  - Test missing/invalid cases
  - **Files:** `test/unit/config.test.ts`

- [x] **Task 11: Unit tests for pool factories**
  - Test `createServicePool()` in `test/unit/pool.test.ts` (or new test file)
  - Test SSL configuration for remote Neon
  - Test pool options
  - **Files:** `test/unit/pool.test.ts`

- [x] **Task 12: Unit tests for Redis client**
  - Test `createRedisClient()` in `test/unit/redis.test.ts`
  - Test connection validation
  - **Files:** `test/unit/redis.test.ts`

- [x] **Task 13: Contract tests for health endpoint**
  - Test `/health/ready` returns 200 when all deps healthy
  - Test `/health/ready` returns 503 with `Retry-After: 5` when any dep fails
  - Add to `test/contract/health.test.ts`
  - **Files:** `test/contract/health.test.ts`

- [x] **Task 14: Integration tests with test databases**
  - Create `test/integration/service-db.test.ts` using disposable test database pattern
  - Test service store CRUD operations
  - Test health check integration with real dependencies
  - Follow existing `postgres-server.ts` pattern
  - **Files:** `test/integration/service-db.test.ts`

## Checkpoint: Foundation Complete

- [x] All tests pass (`npm test`)
- [x] Build succeeds (`npm run build`)
- [x] Type checking passes (`npm run typecheck`)
- [x] Linting passes (`npm run lint`)
- [x] Manual verification: health endpoint returns 200 with all deps available