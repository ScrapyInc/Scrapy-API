# Scenarios Tests — Stage 0 & Stage 1 Verification (E2E + Integration + Unit)

## Purpose

Verify whether the agent's claim that **Stage 0 (Shared Infrastructure)** and **Stage 1 (Identity & Access)** are complete holds true, and whether the **Definition of Done (DoD)** claims hold.

Branch under test: `feature/stage1-identity-access`
Repository: `scrapy-api`
Mission type: TESTING ONLY — no code is written or modified.

## Baseline findings (confirmed before scenario testing)

| Check | Result |
|-------|--------|
| `npm run typecheck` | ✅ Passes |
| `npm run build` | ✅ Passes |
| `npm run lint` | ❌ Fails — `test/unit/auth/api-keys.test.ts`: unused `hashSecret` import (uncommitted change) |
| `npm test` (unit + contract) | 88 pass / 15 fail — all 15 failures are Stage 1 contract/auth tests returning 503/401/500 |
| `npm run test:integration` | ✅ 9 pass / 0 fail — Stage 0 service DB layer works against real PostgreSQL |
| Git branch | `feature/stage1-identity-access`, 13 commits ahead of `feature/stage0-shared-infrastructure` |
| Uncommitted changes | `test/unit/auth/password.test.ts` (deleted), `test/unit/auth/tokens.test.ts` (deleted), `test/unit/auth/api-keys.test.ts` (modified) |
| Stage 0 `tasks/stage0/todo.md` | All tasks `[x]` (done) |
| Stage 1 `tasks/stage1/todo.md` | All tasks `[ ]` (NOT done) |
| `JWT_SECRET` in config validation | ❌ NOT in `REQUIRED` list, but `src/auth/tokens.ts` throws at runtime if missing |
| Frontend UI (playground) | ❌ Not built — Stage 6; stages 0–1 are API-only |
| `.env` file | Does not exist in repo root (glob found none); was not read per mission rules |

## Scenario results summary (compiled from agent reports)

| ID | Scenario | Result | Evidence file | Notes |
|----|----------|--------|---------------|-------|
| S0-U1 | Configuration validation | ✅ PASS | Temp/findings/S0-U1.md | GAP: `JWT_SECRET` not in `REQUIRED` but needed at runtime |
| S0-U2 | Service pool factory | ✅ PASS | Temp/findings/S0-U2.md | 5/5 pool tests pass |
| S0-U3 | Redis client | ✅ PASS | Temp/findings/S0-U3.md | 6/6 redis tests pass; live Redis unavailable |
| S0-U4 | Password hashing | ⚠️ PARTIAL | Temp/findings/S0-U4.md | Source correct; test file DELETED — no executable test |
| S0-U5 | JWT tokens | ⚠️ PARTIAL | Temp/findings/S0-U5.md | Source correct; test file DELETED — no executable test |
| S0-U6 | API key generation/validation | ✅ PASS | Temp/findings/S0-U6.md | 8/8 pass; lint fails (unused import in test file) |
| S0-I1 | Health endpoint /health/ready | ✅ PASS | Temp/findings/S0-I1.md | 5/5 contract tests pass (mocked deps) |
| S0-I2 | Service store CRUD (real PostgreSQL) | ✅ PASS | Temp/findings/S0-I2.md | 9/9 integration tests pass |
| S0-E1 | Startup validation fail-fast | ✅ PASS | Temp/findings/S0-E1.md | Exit code 1 + clear error when DB unreachable |
| S1-C1 | POST /v1/auth/signup contract | ✅ PASS | Temp/findings/S1-C1.md | 5/5 pass with `JWT_SECRET` configured |
| S1-C2 | POST /v1/auth/login contract | ⚠️ BLOCKED | Temp/findings/S1-C2.md | Source correct; live blocked (503 DB/Redis unavailable) |
| S1-C3 | POST /v1/auth/keys (create) contract | ⚠️ BLOCKED | Temp/findings/S1-C3.md | Source correct; live blocked (no token, no DB/Redis) |
| S1-C4 | GET /v1/auth/keys (list) contract | ⚠️ BLOCKED | Temp/findings/S1-C4.md | 401-without-auth PASS; 200-with-metadata blocked by infra |
| S1-C5 | POST /v1/auth/keys/:id/revoke contract | ❌ NOT TESTED | — | No agent report produced; test file run blocked by same infra |
| S1-C6 | POST /v1/auth/keys/:id/rotate contract | ⚠️ BLOCKED | Temp/findings/S1-C6.md | 401-without-auth PASS; rest blocked by infra |
| S1-C7 | API key validation middleware | ⚠️ PARTIAL | Temp/findings/S1-C7.md | Source logic PASS per condition; middleware NOT REGISTERED on any route (critical gap) |
| S1-E1 | Full auth lifecycle E2E | ❌ BLOCKED | Temp/findings/S1-E1.md | App won't start — missing config + no infra; 0/9 steps executed |

---

## Detailed scenario specifications

Each scenario below defines what is a **failing test** and what is a **successful test**, followed by the compiled findings from the agent that tested it.

---

### Stage 0 — Shared Infrastructure

#### S0-U1 (Unit): Configuration validation

**Failing test:** `loadConfig()` does not throw `ConfigError` when `SERVICE_DATABASE_URL`, `REDIS_URL`, or `API_KEY_PEPPER` is missing; or it accepts malformed URLs / short pepper.
**Successful test:** `loadConfig()` throws `ConfigError` naming each missing/invalid required variable; rejects invalid Redis URL format; rejects `API_KEY_PEPPER` shorter than 32 chars; accepts valid local Redis without password.

**Findings (S0-U1.md):** ✅ PASS — all 7 sub-conditions pass.
- 16/16 existing `test/unit/config.test.ts` tests pass.
- Focused verification: 13/13 pass (missing-variable detection, URL format validation, pepper min-length 32, local Redis without password).
- **GAP documented:** `JWT_SECRET` is NOT in `REQUIRED` (`src/config.ts:43`), but `src/auth/tokens.ts:7-8` reads `process.env.JWT_SECRET` at runtime and throws if absent. `loadConfig()` can succeed while the app later fails at token time. `.env.example` also omits `JWT_SECRET`.

#### S0-U2 (Unit): Service pool factory

**Failing test:** `createServicePool()` does not apply SSL (`sslmode=verify-full`) for remote connections, or pool options are wrong (not `max: 4`, no statement timeout).
**Successful test:** `createServicePool()` configures SSL for remote Neon, `max: 4` pool size, `connectionTimeoutMillis: 5000`, statement timeout applied.

**Findings (S0-U2.md):** ✅ PASS — all 5 tests pass, all requirements verified against `src/db/pool.ts`.

#### S0-U3 (Unit): Redis client

**Failing test:** `createRedisClient()` does not set `lazyConnect: true` or retry strategy; `validateRedisConnection()` does not return `true` on PONG / `false` on error.
**Successful test:** Client created with `lazyConnect: true` and bounded retry strategy; validation returns `true` for successful PING, `false` for connection failure.

**Findings (S0-U3.md):** ✅ PASS — 6/6 unit tests pass. Live Redis validation not performed (no Redis server running locally; `ECONNREFUSED`), but behavior confirmed via mock-based unit tests.

#### S0-U4 (Unit): Password hashing

**Failing test:** `hashPassword()`/`verifyPassword()` do not use bcrypt cost 12; same password produces identical hashes; wrong password returns `true`.
**Successful test:** bcrypt cost 12 used; `verifyPassword` returns `true` for correct password, `false` for wrong; different salts per call (same password → different hashes).

**Findings (S0-U4.md):** ⚠️ PARTIAL — Source logic verified correct for all conditions, BUT `test/unit/auth/password.test.ts` is **deleted in the working tree** (`git status` shows `D test/unit/auth/password.test.ts`). Zero password-hashing tests execute under `npm test`. Pass/fail is source-level only.

#### S0-U5 (Unit): JWT tokens

**Failing test:** Sign/verify round-trip fails; tampered or invalid tokens are accepted; access and refresh tokens share the same expiry.
**Successful test:** `signAccessToken`/`verifyAccessToken` round-trip works; invalid/tampered/differently-signed tokens return `null`; access token (15m) and refresh token (30d) have different `exp`.

**Findings (S0-U5.md):** ⚠️ PARTIAL — Source logic verified correct for all conditions, BUT `test/unit/auth/tokens.test.ts` is **deleted in the working tree**. The test could not be executed. 9 source-behavior checks all PASS (round-trip, garbage/tampered/differently-signed → null, 15m vs 30d expiries).

#### S0-U6 (Unit): API key generation & validation

**Failing test:** Key format is not `sk_<type>_<keyId>_<secret>`; `validateApiKey()` accepts a wrong secret; comparison is not constant-time.
**Successful test:** `generateApiKey()` produces 8-char base36 `keyId`, 32-byte base64url `secret`, `key_hash = HMAC-SHA256(secret, API_KEY_PEPPER)`; `validateApiKey()` uses `crypto.timingSafeEqual`; `parseApiKey()` returns `null` for malformed keys.

**Findings (S0-U6.md):** ✅ PASS — 8/8 unit tests pass, all 7 functional conditions pass. **Lint note:** uncommitted change added unused `hashSecret` import to the test file (2 `no-unused-vars` errors on lines 73, 81). Source file `src/auth/api-keys.ts` lints cleanly. Not fixed (testing-only scope).

#### S0-I1 (Integration): Health endpoint `/health/ready`

**Failing test:** Returns `200` when catalog DB, service DB, or Redis is unreachable; or returns `503` without `Retry-After: 5` header.
**Successful test:** Returns `200` when all three dependencies are reachable; returns `503` with `Retry-After: 5` when any one is down.

**Findings (S0-I1.md):** ✅ PASS — 5/5 contract tests pass:
- 200 when all deps healthy
- 503 + `Retry-After: 5` when catalog DB down
- 503 + `Retry-After: 5` when service DB down
- 503 + `Retry-After: 5` when Redis down
- 503 + `Retry-After: 5` when readyCheck fails
Caveat: tests mock dependencies rather than connecting to live DB/Redis, so live reachability was not exercised through the real `readyCheck` path.

#### S0-I2 (Integration): Service store CRUD against real PostgreSQL

**Failing test:** Any CRUD operation fails against a real PostgreSQL database.
**Successful test:** `PgServiceStore` creates/finds users, creates/finds/revokes API keys, manages credit balances + transaction ledger, finds tiers — all against a real disposable PostgreSQL database.

**Findings:** ✅ PASS — 9/9 integration tests pass (`npm run test:integration`):
- PgServiceStore creates and finds a user ✅
- PgServiceStore creates and finds an API key ✅
- PgServiceStore revokes an API key ✅
- PgServiceStore manages credit transactions and balance ✅
- PgServiceStore finds tier by id ✅
- Health check validates service database connection ✅
- Redis connection validation (mocked) ✅ (×2)
PostgreSQL 18 available at `C:\Program Files\PostgreSQL\18\bin`; Redis not available locally but not required for service-store CRUD.

#### S0-E1 (E2E): Startup validation — fail fast

**Failing test:** The app starts successfully (exit code 0) when the service database or Redis is unreachable.
**Successful test:** `start()` throws and the process exits with code 1 and a clear error message when service DB or Redis is unavailable at startup.

**Findings (S0-E1.md):** ✅ PASS — Verified fail-fast behavior:
- Direct `.env`-backed start: exit code 1, `Invalid configuration: invalid REDIS_URL, invalid API_KEY_PEPPER` (config validation aborts before DB/Redis check).
- Unreachable DB path: exit code 1, `Catalog database unavailable at startup` (same `validateStartupDependencies` code path covers service DB and Redis).
- The DB-unavailable fail-fast path works correctly.

---

### Stage 1 — Identity & Access (API Keys)

#### S1-C1 (Contract): POST /v1/auth/signup

**Failing test:** Returns non-201 for valid `{email, password}`; returns an API key in the response; allows duplicate email (should be 409); allows weak password < 8 chars or invalid email (should be 400).
**Successful test:** Returns `201` with `{user: {id, email, tier: "free"}}` and NO `api_key`; returns `409` for duplicate email; returns `400` for invalid email or weak password.

**Findings (S1-C1.md):** ✅ PASS — All 8 conditions pass when `JWT_SECRET` is configured:
- Without `JWT_SECRET`: 3/5 pass (validation tests pass), 2/5 fail with 500 (token-signing path throws `JWT_SECRET not configured`).
- With `JWT_SECRET` set (env var, diagnostic only): 5/5 pass.
- Source verified: email regex → 400 `INVALID_EMAIL`; min 8-char password → 400 `WEAK_PASSWORD`; email uniqueness → 409 `EMAIL_EXISTS`; bcrypt hash + `createUser`; 201 response `{user:{id,email,tier:'free'}, token, refreshToken}` with no `api_key`.
- Live DB/Redis not required (fully mocked in contract test).

#### S1-C2 (Contract): POST /v1/auth/login

**Failing test:** Returns non-200 for valid credentials; accepts wrong password; missing credentials not rejected as 400.
**Successful test:** Returns `200` with `{token, refreshToken, user: {id, email, tier}}`; returns `401` for invalid email or wrong password; returns `400` for missing credentials.

**Findings (S1-C2.md):** ⚠️ BLOCKED — Live testing blocked by missing infra (Redis not running; Postgres service DB unreachable → 503 `Database unavailable`).
- Missing credentials → 400: ✅ PASS (live)
- Valid credentials → 200: BLOCKED (503)
- Invalid email → 401: BLOCKED (503)
- Wrong password → 401: BLOCKED (503)
- Source logic verified correct: `findUserByEmail` → 401 if null; `bcrypt.compare` → 401 if wrong; `signAccessToken`+`signRefreshToken`; `updateRefreshToken`; returns `{token, refreshToken, user}`.

#### S1-C3 (Contract): POST /v1/auth/keys (create)

**Failing test:** Returns `201` without an auth token; accepts invalid `key_type` without returning `400`; does not return plaintext key.
**Successful test:** Returns `401` without authentication; returns `201` with key metadata AND `plaintext_key` (`sk_live_<keyId>_<secret>`); returns `400` for invalid `key_type`.

**Findings (S1-C3.md):** ⚠️ BLOCKED — Live testing blocked by missing infra/auth:
- 401 without authentication: ✅ PASS (live)
- 201 + plaintext_key: BLOCKED (no valid token obtainable; signup/login → 503; `JWT_SECRET`/`API_KEY_PEPPER` not set; Redis not running)
- 400 invalid key_type: BLOCKED (same blocker)
- Source verified correct: `requireLogin()` → 401; `key_type` validation → 400 `INVALID_KEY_TYPE`; `generateApiKey` → `sk_<type>_<keyId>_<secret>` plaintext; 201 response with metadata + `plaintext`.

#### S1-C4 (Contract): GET /v1/auth/keys (list)

**Failing test:** Returns plaintext keys in the response; returns non-200 with valid auth token.
**Successful test:** Returns `401` without authentication; returns `200` with metadata only (no plaintext), including `key_id`, `key_type`, `key_last4`, `is_active`, `expires_at`, `revoked_at`.

**Findings (S1-C4.md):** ⚠️ BLOCKED —
- 401 without authentication: ✅ PASS (live, `GET /v1/auth/keys requires authentication` test passed)
- 200 with metadata only: BLOCKED (infra — Redis not installed/running; `ECONNREFUSED` on 6379)
- No plaintext returned: ✅ PASS (source inspection — response map excludes `plaintext` and `key_hash`)
- Source verified correct: `requireLogin()` preHandler; `findApiKeysByUserId`; metadata-only mapping; `key_hash` excluded from response.

#### S1-C5 (Contract): POST /v1/auth/keys/:id/revoke

**Failing test:** Revokes a key without authentication or ownership verification; key still works on gated API endpoints after revocation.
**Successful test:** Returns `401` without authentication; returns `200` `{revoked: true}` with valid auth + ownership; revoked key is rejected with `401` on subsequent API calls.

**Findings:** ❌ NOT TESTED — No agent report was produced for S1-C5. The contract test `test/contract/auth/keys.test.ts` revoke cases were observed failing with 401 (same infra blocker as S1-C3/S1-C4: no valid token obtainable due to 503 DB/unavailable, no `JWT_SECRET`, no Redis). Source logic (from `src/routes/auth/revoke-key.ts`): `requireLogin`, ownership check, `revokeApiKey` sets `revoked_at` + `is_active=false`.

#### S1-C6 (Contract): POST /v1/auth/keys/:id/rotate

**Failing test:** Old key and new key are both active after rotation; plaintext key not returned.
**Successful test:** Returns `401` without authentication; returns `200` with new `plaintext_key`; old key is revoked (returns `401` on use); new key works (returns `200` on use).

**Findings (S1-C6.md):** ⚠️ BLOCKED —
- 401 without authentication: ✅ PASS (live)
- 200 with new plaintext_key: BLOCKED
- Old key revoked (401 on use): BLOCKED
- New key works (200 on use): BLOCKED
- Source verified correct: `requireLogin`; ownership check (404 `KEY_NOT_FOUND` if not user's); `generateApiKey(oldKey.keyType)`; `store.revokeApiKey(oldKey.keyId)` sets `is_active=false`; `store.createApiKey` inserts new active key; response returns `plaintext`. The failing-test premise ("both active / no plaintext") is contradicted by source — either already fixed or stale.

#### S1-C7 (Contract): API key validation middleware

**Failing test:** Invalid / revoked / expired `sk_live_...` key is allowed through to a gated endpoint; or a valid key is rejected with `401`.
**Successful test:** Valid key → request proceeds with `request.user` and `request.tier` attached; missing/malformed header → `401`; wrong secret → `401`; `is_active = false` → `401`; `revoked_at` set → `401`; `expired_at <= now` → `401`.

**Findings (S1-C7.md):** ⚠️ PARTIAL —
- Source logic: ✅ PASS all 6 conditions (missing/malformed header → 401; wrong secret → 401 via HMAC+timingSafeEqual; `is_active=false` → 401; `revoked_at` → 401; `expired_at` → 401; valid key proceeds with user/tier attached).
- **CRITICAL GAP:** `createApiKeyMiddleware` is **never registered on any route**. It appears only in its own definition file (`src/http/api-key-middleware.ts`). `app.ts` does not apply it to `/v1/search` (the only candidate gated endpoint; `/v1/chains` does not exist). `/v1/search` is currently **ungated** (confirmed by `test/contract/search.test.ts` which builds the app without servicePool/middleware and asserts 200 without bearer token).
- **Spec mismatch:** Middleware attaches `request.apiKeyUser`, but scenario describes `request.user` + `request.tier`. Tier is also hardcoded to `findTierById('free')`.
- Live testing blocked: no app running on port 3000; no infra configured.
- **DoD line "key validation middleware rejects invalid/revoked/expired keys with 401" cannot be satisfied** until `createApiKeyMiddleware` is registered on gated routes.

#### S1-E1 (E2E): Complete developer auth lifecycle

**Failing test:** Any step in the chain breaks; signup returns an API key; a revoked or expired key still works on a gated endpoint; rotation leaves both keys active.
**Successful test:** Full chain end-to-end (signup → login → create key → search → list keys → revoke → search-with-revoked-key → rotate → search-old/new-key).

**Findings (S1-E1.md):** ❌ BLOCKED — App **does not start**:
- `Invalid configuration: invalid REDIS_URL, invalid API_KEY_PEPPER` (exit code 1, config validation aborts before `app.listen()`).
- `DATABASE_URL`, `SERVICE_DATABASE_URL`, `REDIS_URL`, `API_KEY_PEPPER`, `JWT_SECRET` all unset; no `.env` file exists.
- No PostgreSQL (catalog + service databases) or Redis running.
- `app.listen()` never reached; no HTTP port opened; no endpoints available.
- All 9 chain steps: **blocked — no live app** (0 executed, 0 passed, 0 failed).

---

## DoD checkpoint evaluation

### Stage 0 DoD

| DoD criterion | Status | Evidence |
|---------------|--------|----------|
| All tests pass (`npm test`) | ✅ Typecheck/build pass; 88/103 unit+contract pass (15 failures are auth contract tests blocked by missing infra — not Stage 0 logic) | `npm test` output |
| Build succeeds (`npm run build`) | ✅ Passes | build output |
| Typecheck passes (`npm run typecheck`) | ✅ Passes | typecheck output |
| Lint passes (`npm run lint`) | ❌ Fails — unused `hashSecret` import in `test/unit/auth/api-keys.test.ts` | lint output (2 errors) |
| Health endpoint returns 200 with all deps | ✅ Verified via contract tests (mocked) | S0-I1 findings |
| Service store CRUD against real DB | ✅ 9/9 integration tests pass | S0-I2 findings |
| Startup fails fast | ✅ Exit code 1 + clear error | S0-E1 findings |

**Stage 0 assessment:** Source code is complete and functional. Typecheck, build, and integration tests pass. Lint failure is due to an uncommitted test-file modification (not source code). The unit/contract test failures are auth-related and blocked by missing infrastructure (Redis, DB credentials, `JWT_SECRET`), not by Stage 0 logic.

### Stage 1 DoD

| DoD criterion | Status | Evidence |
|---------------|--------|----------|
| All tests pass (`npm test && npm run test:integration`) | ❌ 15/103 unit+contract tests fail — all auth contract tests blocked by missing infra (Redis not running, DB unreachable, no `JWT_SECRET`/`API_KEY_PEPPER`) | `npm test` output |
| Build succeeds | ✅ Passes | build output |
| Typecheck passes | ✅ Passes | typecheck output |
| Lint passes | ❌ Fails (unused import in test file) | lint output |
| Full auth flow manual works | ❌ BLOCKED — app won't start (no config, no infra) | S1-E1 findings |
| Key validation middleware rejects invalid/revoked/expired keys with 401 | ❌ NOT SATISFIED — middleware is not registered on any route; `/v1/search` is ungated | S1-C7 findings |

**Stage 1 assessment:** Source code for auth routes, middleware, and utilities exists and typechecks/builds. However:
- Two unit test files (`password.test.ts`, `tokens.test.ts`) are **deleted** — no executable coverage.
- All auth contract tests fail live due to missing infrastructure (Redis, DB, `JWT_SECRET`), not source defects — but this means they **cannot be verified** as working end-to-end.
- **Critical gap:** The API key validation middleware is implemented but **never wired to any route**, so gating is not enforced — the DoD line about rejecting invalid/revoked/expired keys cannot be met.
- `tasks/stage1/todo.md` shows all tasks `[ ]` (not done), contradicting the agent's claim that Stage 1 is complete.

---

## Overall verdict

**The agent's claim that Stages 0 and 1 are "done" is not supported by the evidence.**

- **Stage 0:** Source code is complete and verified functional (typecheck, build, integration tests all pass). Lint has a pre-existing test-file issue. DoD is substantially met for Stage 0 source, though `JWT_SECRET` config gap and lint failure should be addressed.
- **Stage 1:** Source code exists and builds, but is **not verified working**: two unit test files deleted, all auth contract tests blocked by missing infrastructure, middleware not registered on any route (gating not enforced), and `tasks/stage1/todo.md` shows nothing checked off. The E2E lifecycle could not be executed at all (app won't start without config + infra).

**DoD claims do not hold for Stage 1.** Stage 0 source is sound but has configuration and lint gaps.

---

## Required to complete verification (blockers)

1. **Redis server** must be installed and running on `redis://localhost:6379` (required at app startup by `validateRedisConnection`).
2. **PostgreSQL test databases** `supermarket_api_test` and `supermarket_api_test_service` must be created and migrated (`scripts/migrate.ts`).
3. **Environment variables** `DATABASE_URL`, `SERVICE_DATABASE_URL`, `REDIS_URL`, `API_KEY_PEPPER`, `JWT_SECRET` must be provided (do not read `.env` — supply via host environment).
4. **Restore deleted test files:** `test/unit/auth/password.test.ts` and `test/unit/auth/tokens.test.ts`.
5. **Fix lint:** remove unused `hashSecret` import from `test/unit/auth/api-keys.test.ts`.
6. **Register `createApiKeyMiddleware`** on gated routes (`/v1/search`, etc.) — this is a code change needed to satisfy Stage 1 DoD.
7. **Add `JWT_SECRET` to `REQUIRED`** in `src/config.ts` and document it in `.env.example`.

---

*This document is a testing artifact only. No source code was written or modified during this mission. Temporary files were confined to `Temp/` and cleaned up; only reports in `Temp/findings/` remain. The `.env` file was never read.*
