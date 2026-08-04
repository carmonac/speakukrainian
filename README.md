# Speak Ukrainian

A Ukrainian-language learning site — grammar explanations, listening practice and interactive
H5P exercises — with an admin panel for authoring all of it, and bookable lesson slots.

Modelled on [test-english.com](https://test-english.com).

## Stack

|             |                                                   |
| ----------- | ------------------------------------------------- |
| API         | NestJS 11 (ESM) · Firestore · Cloud Storage · H5P |
| Admin       | Angular 22 · Material · Tiptap rich text          |
| Public site | Angular 22 with server-side rendering             |
| Shared      | Zod schemas — one source of truth for the domain  |
| Build       | pnpm workspaces · Turborepo                       |
| Hosting     | Cloud Run, three services                         |

## Getting started

Requires Node 22.18+ (the seed script runs as TypeScript through Node's type stripping),
pnpm 11+, and Docker.

```bash
pnpm install
cp .env.example .env
pnpm emulators:up      # Firestore + Auth + fake Cloud Storage
pnpm seed:admin        # an admin account to sign in with
pnpm dev
```

### The admin account

The Auth emulator starts empty, so `pnpm seed:admin` creates the account the admin panel signs
in with. It defaults to `admin@speakukrainian.local` / `password`, gives it the `admin` custom
claim the API's role guard reads, and writes the matching `users/{uid}` profile document.

```bash
pnpm seed:admin
pnpm seed:admin --email=me@example.com --password=hunter22 --name="Me" --role=editor
pnpm seed:admin --reset-password    # forgotten the password of an existing account
```

Flags override `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` and `SEED_ADMIN_NAME` from `.env`. The
script is idempotent: running it again reuses the same account and rewrites the same profile
document rather than creating a second one. The password of an account that already exists is
left alone unless `--reset-password` is given — setting it again would invalidate every ID token
already issued for that account, and the API rejects revoked tokens. It refuses to run unless
both `FIREBASE_AUTH_EMULATOR_HOST` and `FIRESTORE_EMULATOR_HOST` are set, so it can never reach
a real project.

Only `editor` and `admin` may enter the admin panel. To promote someone, sign in as an admin and
call `PATCH /api/users/:uid/role`; the change takes effect on their next page refresh, without a
sign-out.

|             |                                |
| ----------- | ------------------------------ |
| Public site | http://localhost:4300          |
| Admin panel | http://localhost:4200          |
| API         | http://localhost:8080          |
| API docs    | http://localhost:8080/api/docs |
| Emulator UI | http://localhost:4001          |

## Checks

```bash
pnpm lint typecheck test build
pnpm --filter @speakukrainian/api test:e2e   # needs emulators running
```

## How development works

Work is driven by GitHub issues through an agent loop, defined in `.claude/`:

```
/next-task              architect plans → coder implements → QA verifies → reviewer reviews → PR
                                              ↑                    │
                                              └────────────────────┘   sent back on failure

/read-human-comments    human PR feedback → coder → QA → replies posted on GitHub
```

Every PR is reviewed and merged by a human. No agent merges.

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — conventions and the rules agents must follow
- [`docs/architecture.md`](docs/architecture.md) — decision records and data model
