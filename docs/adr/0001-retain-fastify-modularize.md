# ADR 0001 — Retain Fastify and modularize into domain plugins

- **Status:** Proposed
- **Date:** 2026-11-05
- **Deciders:** API maintainers
- **Related:** `docs/intent/developer-platform.md`, `docs/specs/stage-0..6`, `tasks/stage1/plan.md`, `tasks/stage2/plan.md`

## Context

The service began as a small, unauthenticated catalog/search API and is now
transitioning into a production developer platform. The roadmap adds identity
and API keys (Stage 1), subscriptions and credits (Stage 2), metering and
enforcement (Stage 3), x402 payments (Stage 4), an MCP server (Stage 5), and a
developer playground (Stage 6).

Current implementation:

- TypeScript ESM on Node 24, run with `node --experimental-strip-types`.
- Fastify 5.12.7, exactly three runtime dependencies (`fastify`, `ioredis`, `pg`).
- Hand-written `pg` SQL and transactions; no ORM.
- Custom `HttpError` envelope, custom logger, custom in-memory rate limiter.
- Contract tests use `node:test` and `app.inject()`.
- Stages 1 and 2 have detailed, Fastify-specific implementation plans that are
  not yet executed.

The question raised: has the project outgrown Fastify and should it migrate to
NestJS?

## Decision drivers

1. Preserve delivery speed on Stages 1–3, where correctness of auth, billing, and
   quota enforcement matters most.
2. Keep the toolchain simple: type stripping, no decorator transform, no
   `reflect-metadata`.
3. Keep the existing contract-test strategy (`node:test` + `app.inject()`).
4. Avoid rewriting behavior that is already proven (error envelope, request-id
   logging, config validation, readiness checks).
5. Provide enough structure that the codebase does not degrade as auth, billing,
   metering, payments, and MCP are added.

## Decision

**Retain Fastify. Do not migrate to NestJS at this time.**

Introduce explicit domain boundaries as encapsulated Fastify plugins before
starting Stage 1:

```
src/
  modules/
    catalog/       # scraper-owned read model (existing search)
    identity/      # Stage 1: API keys, principals
    billing/       # Stage 2: subscriptions, credits
    metering/      # Stage 3: counters, caps, 429 headers
    payments/      # Stage 4: x402
    mcp/           # Stage 5: Streamable HTTP MCP tools
  platform/        # pool, redis, config, logger, errors, request-context
  app.ts           # composition root only
```

Each module exports a Fastify plugin and receives its dependencies explicitly.
Cross-cutting concerns are expressed as Fastify hooks:

- Identity: `preHandler` that resolves and validates the API key, attaching the
  principal to request context.
- Entitlement: `preHandler` that rejects on inactive subscription or exhausted
  credits.
- Metering: `onResponse`/`preHandler` pair backed by Redis counters.

`app.ts` remains a composition root with no domain logic.

## Consequences

### Positive

- No rewrite: error envelope, logging, readiness, config, and contract tests stay
  intact and keep passing.
- No toolchain change: `--experimental-strip-types` keeps working, because no
  decorators or `emitDecoratorMetadata` are introduced.
- Existing Stage 1 and Stage 2 plans remain valid and can be executed as written.
- Runtime dependency surface stays small and auditable.
- No measured or expected performance regression; the workload is database-bound.
- MCP can be mounted with the official `@modelcontextprotocol/fastify` adapter.

### Negative

- Module boundaries are enforced by review and conventions, not by a framework.
  This requires a short written conventions note and discipline.
- No built-in guard/interceptor/pipe abstractions; equivalent behavior must be
  composed from hooks. This is a small amount of repeated code per concern.
- Onboarding relies on reading the codebase rather than recognizing Nest
  conventions.

### Risks

- If the team grows substantially or the domain count explodes, the absence of a
  framework convention could become a real cost. Mitigated by the revisit
  triggers below.
- Plugin encapsulation is easy to get wrong (accidental global registration).
  Mitigated by keeping shared platform code in `src/platform` and registering
  domain plugins under explicit prefixes.

## Alternatives considered

### A. Full NestJS rewrite now

Rejected. Requires switching dev/test/build off `--experimental-strip-types`
(Node type stripping does not transform decorators) to `tsx` or a full `tsc`
pipeline with `experimentalDecorators` and `emitDecoratorMetadata`. Forces a
rewrite of the error envelope, hooks, config injection, and every contract test,
and invalidates the existing Stage 1 and Stage 2 plans. Delivers no capability
that Fastify lacks for Stages 1–6.

### B. NestJS on the Fastify adapter (`@nestjs/platform-fastify`)

Deferred, not rejected. This is the preferred shape **if** a future migration is
triggered, because it retains Fastify as the HTTP engine via
`NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())`.
It still carries the decorator/toolchain and test-rewrite costs above, so it is
not justified today.

### C. Big-bang rewrite later, after Stage 3

Rejected. Cost and regression risk grow monotonically with each stage added, so
"later" is strictly worse than "now" if migration were the right call. Since it
is not the right call, this option is moot.

### D. Leave `app.ts` unstructured and keep adding routes

Rejected. This is the actual problem the NestJS question was pointing at. It is
addressed by the module layout in the decision above at a fraction of the cost.

## Revisit triggers

Re-open this decision if any of the following becomes true:

1. Backend team grows to roughly four or more engineers working concurrently.
2. More than six domains require shared cross-cutting concerns, and hook
   composition starts duplicating meaningfully.
3. Hiring or onboarding consistently expects NestJS conventions.
4. A required capability exists only in the Nest ecosystem and has no reasonable
   Fastify equivalent.
5. Scheduled review at the end of Stage 3, once metering and enforcement are live.

## Action items

- [ ] Create `docs/adr/` and add this record.
- [ ] Introduce `src/modules/*` and `src/platform/*` before Stage 1 begins.
- [ ] Add a short `docs/conventions.md` describing module shape, hook usage, and
      dependency injection rules.
- [ ] Keep `app.inject()` contract tests as the primary behavioral test boundary.