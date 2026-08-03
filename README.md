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

Requires Node 22+, pnpm 11+, and Docker.

```bash
pnpm install
cp .env.example .env
pnpm emulators:up      # Firestore + Auth + fake Cloud Storage
pnpm dev
```

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
