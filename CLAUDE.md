# CLAUDE.md — trip-planner

## What this is

Overland trip planner. Next.js 14 app with an AI chat assistant ("Penny") that helps users plan multi-leg road trips with stops, routes, fuel planning, and GPX import. Deployed on Vercel, backed by Neon Postgres.

## Stack

- **Framework:** Next.js 14 (App Router, React 18)
- **DB:** Neon Postgres via `postgres` driver + Drizzle ORM
- **Auth:** NextAuth v5 (beta) — OTP email + Google OAuth
- **AI:** Anthropic SDK — chat agent with tool-use in `src/lib/penny/`
- **Email:** Resend
- **Maps:** Google Maps (client JS API + server Directions API)
- **Tests:** Vitest (unit), Playwright (e2e)
- **Language:** TypeScript throughout, Zod for validation

## Commands

```bash
npm run dev          # local dev server
npm run build        # production build
npm run test         # vitest unit tests
npm run e2e          # playwright (needs running app + seeded DB)
npm run e2e:smoke    # subset of critical e2e tests
npm run db:generate  # drizzle-kit generate migrations
npm run db:push      # push schema to DB
npm run db:migrate   # run migrations via tsx
npm run ship         # deploy script (scripts/ship.sh)
```

## Architecture

```
src/
  app/              # Next.js App Router — pages + API routes
    api/            # REST endpoints (trips, stops, routes, vehicles, etc.)
    trips/          # Trip workspace UI
    admin/          # Admin dashboard
    login/          # OTP + Google auth flow
  components/       # React components (client-side)
  lib/              # Shared utilities, API client, maps, coords
    penny/          # AI chat agent — tools, context builder, routing logic
      tools/        # Individual Penny tool implementations
  server/           # Server-only code
    db/             # schema.ts (single file), client.ts
    repos/          # Data access layer — one file per entity
    auth/           # Auth config, guards, OTP, admin checks
  types/            # Shared TypeScript types
scripts/            # CLI utilities (seed, migrate, backfill, smoke tests)
drizzle/            # Generated migration SQL files
e2e/                # Playwright test specs
```

### Patterns

- **Repo pattern:** All DB queries go through `src/server/repos/*.ts` — never raw SQL in routes.
- **API routes** are thin: validate input with Zod, call repo, return JSON.
- **Penny tools** each export a single function matching the Anthropic tool-use spec. Tool index in `src/lib/penny/tools/index.ts`.
- **Units:** User preference (metric/imperial) stored in DB, propagated via `UnitsContext`.
- **Schema:** Single file at `src/server/db/schema.ts`. Drizzle manages all migrations.
- **Auth middleware:** Edge-safe cookie check in `middleware.ts`; real auth via `auth()` in server code.

## Conventions

- No `any` types. Use Zod schemas for API input validation.
- CSS Modules for component-scoped styles (e.g., `admin.module.css`).
- Server components by default; `"use client"` only when needed.
- Env vars: copy `.env.example` to `.env`. Never commit `.env`.
- Admin access: hardcoded allowlist in `src/server/auth/admin.ts`.

## Working with this codebase

- **Schema changes:** Edit `schema.ts` → `npm run db:generate` → `npm run db:migrate`
- **New API route:** Create `src/app/api/<resource>/route.ts`, add repo if needed
- **New Penny tool:** Add to `src/lib/penny/tools/`, register in `index.ts`
- **E2E tests:** Need a running dev server and seeded test DB (`npm run e2e:seed`)
