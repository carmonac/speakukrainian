# Speak Ukrainian

A Ukrainian-language learning site in the shape of test-english.com: grammar explanations,
listening practice, and interactive H5P exercises — plus an admin panel where all of that
content is authored, and bookable lesson slots.

## Repository layout

```
apps/
  api/        NestJS 11 (ESM) — Firestore, Cloud Storage, H5P, auth
  admin/      Angular 22 SPA — the authoring panel
  web/        Angular 22 SSR — the public site
packages/
  shared/     Zod schemas + types. The single source of truth for the domain.
docker/       Local emulators (Firestore, Auth, fake Cloud Storage)
docs/         Architecture decisions
.claude/      Agent definitions and slash commands
.agent/       Per-issue plans and loop state (gitignored working notes)
```

## Commands

Run from the repo root. Turborepo fans them out.

```bash
pnpm install
pnpm emulators:up          # Firestore + Auth + fake GCS in Docker
pnpm dev                   # all apps in watch mode
pnpm lint typecheck test build
pnpm --filter @speakukrainian/api test:e2e   # needs emulators up
```

Ports: API `8080`, admin `4200`, public site `4300`, Firestore `8081`, Auth `9099`,
emulator UI `4001`, storage `4443`.

## The rules that matter

These are not style preferences. Breaking one is a defect.

1. **`packages/shared` is the single source of truth for the domain.** Types and validation
   live there as Zod schemas; the API and both front ends import them. Never redeclare a
   domain type locally — a duplicate will drift and the drift will not be caught by the
   compiler.

2. **Every user-visible content field is localized**, as `Record<LocaleCode, string>`. Seed
   locales are `en`, `es`, `uk`, and admins add more at runtime, so never hard-code the list.
   Decide and document what happens when a translation is missing rather than letting it
   render as `undefined`.

3. **Every admin text area is a rich text editor.** There are no plain `<textarea>` fields
   for content — use `LocalizedRichTextEditor`. This is a product requirement, not a
   preference.

4. **Audio is first-class content.** The editor must be able to embed audio, not just images.
   This is a language-learning product; pronunciation clips are the point. Audio is a proper
   editor node (`audio.extension.ts`), not raw embedded HTML.

5. **The admin uses real routes.** Every screen has its own URL and survives a refresh and a
   deep link. Transient state — an open panel, a draft being carried between screens — goes
   in `history.state` via `router.navigate(..., { state })`, never in a service that a refresh
   would clear. Guards pass state with `RedirectCommand`, since `createUrlTree` cannot carry it.

6. **The public site is server-rendered.** SEO is the reason it exists in this shape. Touching
   `window` or `document` at module scope crashes the render, and no unit test will catch it.

7. **Clients never talk to Firestore directly.** Everything goes through the API, which holds
   admin credentials. The Firestore rules deny all direct access on purpose.

8. **Every mutating API route carries a role guard.** Authentication is global-by-default;
   `@Public()` is the deliberate opt-out for the public site's read paths.

## Conventions

**TypeScript** — strict everywhere, TS 6.0 (pinned by Angular 22). No `any`. No
`@ts-expect-error` without a comment saying what would remove it.

**API (NestJS, ESM)** — relative imports carry the `.js` extension. Injection tokens live in
their own `*.tokens.ts` file, never in the module that provides them: a module imports its
services and the services need the token, and under ESM that cycle leaves the token in its
temporal dead zone and crashes at boot. Repositories extend `BaseRepository`; business logic
lives in services; controllers only validate and delegate.

`@typescript-eslint/consistent-type-imports` is **off** for the API and must stay off. Nest
resolves constructor injection from `emitDecoratorMetadata`, and a `type` import is erased
before that metadata is written — the autofix produces code that compiles and then fails to
resolve dependencies at runtime.

**Angular** — standalone components, signals, `inject()`, zoneless change detection. Use the
new control flow (`@if` / `@for`), not the legacy structural directives.

**Firestore** — always reference collections through `COLLECTIONS`. Timestamps are stored
natively and converted to ISO strings at the repository boundary, so nothing above that layer
ever sees a `Timestamp`. Never read a collection unbounded; paginate.

**Storage** — the local endpoint config is `STORAGE_API_ENDPOINT`, deliberately _not_
`STORAGE_EMULATOR_HOST`: the Cloud Storage SDK special-cases that name and derives its own
base URL, which then fights the `apiEndpoint` we pass and makes every object request 404.

**Comments** — explain _why_. Do not narrate code, restate a type, or address a reviewer.

**Tests** — colocated `*.spec.ts`, Vitest everywhere. A test must be able to fail: assert
outcomes, not that a mock was called. No skipped or `.only` tests.

**Commits** — conventional commits, `Refs #<issue>`.

## How work gets done

Work is driven by GitHub issues through an agent loop:

```
/next-task            architect → coder → QA → reviewer → PR
                                    ↑        │
                                    └────────┘  QA fails or reviewer blocks
/read-human-comments  human PR feedback → coder → QA → reply
```

The Architect plans (`.agent/plans/issue-N.md`), the Coder implements on
`feat/<N>-<slug>`, QA verifies against the acceptance criteria, the Reviewer checks design.
Loop state accumulates in `.agent/state/issue-N.md`. A human reviews and merges every PR —
no agent merges.

Agent definitions are in `.claude/agents/`. Read them before changing how the loop behaves.
