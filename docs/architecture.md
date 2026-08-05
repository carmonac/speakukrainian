# Architecture

## Shape

Three deployables on Cloud Run, one shared domain package.

```
                    ┌──────────────┐
   learners ───────▶│  web (SSR)   │──┐
                    └──────────────┘  │
                                      ├──▶ ┌─────┐──▶ Firestore
                    ┌──────────────┐  │    │ api │──▶ Cloud Storage
   admins ─────────▶│ admin (SPA)  │──┘    └─────┘──▶ Firebase Auth
                    └──────────────┘
```

`packages/shared` holds the Zod schemas all three import. It is the reason a field added to
a section shows up as a type error in the admin form and the public renderer at the same time.

## Decision records

### ADR-001 — One API, no direct client access to Firestore

Firestore security rules deny everything. All reads and writes go through the API, which
holds admin credentials.

_Why:_ the alternative — clients querying Firestore directly with rules as the authorization
layer — spreads authorization logic across rules files, both front ends and the API, and
makes derived data (section paths, publish state) impossible to keep consistent. One
enforcement point is worth the extra hop.

_Cost:_ the public site pays a network hop during SSR. Mitigated by pointing the SSR renderer
at the API's internal Cloud Run URL rather than back out through the public load balancer.

### ADR-002 — Sections are a materialized tree

A section stores `parentId`, `ancestorIds[]`, `depth` and a full `path`.

_Why:_ the public site resolves a URL like `/en/grammar-points/present-simple` in one indexed
query on `path`, instead of walking parents one document at a time. The menu and the
subsection-list pages need a whole subtree, which `ancestorIds` gives in a single query.

_Cost:_ re-parenting a section must rewrite `path`, `depth` and `ancestorIds` for the node
**and every descendant**, transactionally. This is the single most defect-prone operation in
the codebase — a stale descendant path is a broken public URL. It gets integration tests, not
unit tests with mocks.

### ADR-003 — Rich text is stored as sanitized HTML

Not Markdown, not a portable-text JSON tree.

_Why:_ the content genuinely needs embedded audio players, images and tables. HTML is what the
editor produces and what the renderer consumes, with no lossy conversion in between. Markdown
cannot express an audio node without falling back to raw HTML anyway.

_Cost:_ HTML must be sanitized on write, server-side. The admin sanitizes for immediate
feedback, but a compromised browser can post anything, so the API sanitizes again and that is
the check that counts.

### ADR-004 — Audio is a first-class editor node

`audio.extension.ts` defines an atom node rather than letting authors paste raw `<audio>` HTML.

_Why:_ this is a language-learning product — pronunciation clips are core content. A real node
is selectable, deletable and serializable like any other block, and it carries the storage
object path, which is what lets us find and collect orphaned uploads later.

### ADR-005 — Admin state lives in the URL and `history.state`

Every admin screen is a route. Transient state travels in `history.state`.

_Why:_ an authoring tool where a refresh loses your place, or where a link to a specific
section cannot be shared with a colleague, is a tool people work around. Angular's
`RedirectCommand` carries state from a guard, which `createUrlTree` cannot.

### ADR-006 — Public site is server-rendered per request

`RenderMode.Server`, not prerendering.

_Why:_ content is authored in Firestore and published at arbitrary times. Prerendering would
require a rebuild per publish. Per-request rendering with a CDN `s-maxage` plus
`stale-while-revalidate` gets the SEO benefit and near-static latency, and a publish
propagates in about a minute without a deploy.

### ADR-007 — H5P via `@lumieducation/h5p-server`

_Why:_ it is the maintained Node implementation of the H5P specification, and it supports the
authoring widget — which the requirement to _edit_ uploaded H5P, not merely host it, makes
mandatory. Its storage interfaces are pluggable, so content and libraries live in Cloud
Storage rather than on a container filesystem that Cloud Run will discard.

### ADR-008 — The API is ESM

_Why:_ `packages/shared` is ESM, and CommonJS consuming it would need a dual build. TypeScript
6 also deprecates the `node10` resolution that the classic NestJS CommonJS setup relies on.

_Cost:_ relative imports need `.js` extensions, and injection tokens must live outside the
modules that provide them — under ESM, the module ↔ service import cycle leaves the token in
its temporal dead zone and the app crashes at boot with `Cannot access 'X' before
initialization`. Both costs are paid once, in conventions.

### ADR-009 — A missing translation falls back to the default locale

`resolveLocalized(value, locale, defaultLocale)` in `packages/shared/src/common.ts` returns the
requested locale's text, else the default locale's, else `''`. A value that is present but blank
counts as missing: the localized editor writes a key for any tab the author opens, so
`{ en: 'Hello', uk: '' }` is what half-translated content actually looks like.

_Why:_ CLAUDE.md rule 2 requires a decision here, and the alternatives are worse. Rendering
`undefined` is a defect; rendering an empty hole gives a learner a page with a missing heading and
no way to guess what it said. A half-translated site that reads in English is usable, and the gap
is visible to the admin rather than to the reader as a blank.

_Scope:_ this governs **rendering**, not **authoring**. An editor never falls back:
`LocalizedRichTextEditor` shows an empty tab for a locale it holds no text for, because showing the
English text under the Ukrainian tab would have the author "translate" a copy of text that is
already stored under another locale and save it as the Ukrainian translation.

_Cost:_ the public site cannot tell "translated" from "falling back" without comparing the two, so a
translation-coverage view is its own feature. Disabling or deleting a locale therefore never touches
stored content — the text stays in Firestore and reappears if the locale comes back.

### ADR-010 — Public read routes return a projection, never the stored document

A route marked `@Public()` answers with a schema of its own — `publicLocaleSchema` is the first —
that omits `audit`. Admin routes keep returning the full document.

_Why:_ `audit.createdBy` / `updatedBy` are the Firebase uids of the staff who authored the content.
A uid is not a credential, but handing every anonymous reader a list of the people who run the site
buys nothing: no client reads `audit`. Deciding it on the first public route means sections, pages
and schedule slots have a shape to copy rather than inventing one each.

_Cost:_ a second schema per publicly-read collection, and the projection has to be applied at the
route. It stays in `packages/shared` and is derived from the stored schema with `.omit()`, so the
two cannot drift (rule 1).

## Data model

| Collection      | Holds            | Notes                                                                           |
| --------------- | ---------------- | ------------------------------------------------------------------------------- |
| `locales`       | site languages   | doc id is the locale code; exactly one `isDefault`                              |
| `sections`      | the content tree | `parentId`, `ancestorIds`, `depth`, `path`; `kind` is `content` or `link`       |
| `pages`         | page content     | `body` is a discriminated union: `rich_text`, `subsection_list`, `h5p_exercise` |
| `scheduleSlots` | bookable time    | UTC instants plus the authoring IANA zone                                       |
| `users`         | profile and role | doc id is the Firebase Auth uid                                                 |
| `h5pContent`    | H5P index        | metadata over content stored in Cloud Storage                                   |

Storage prefixes: `images/`, `audio/`, `h5p/content/`, `h5p/libraries/`, `h5p/temp/`.

## Local development

`docker compose up` runs the Firestore and Auth emulators (a custom image with a JRE and
`firebase-tools` baked in, so start is fast) and `fake-gcs-server` for Cloud Storage.

One trap worth knowing: the Cloud Storage SDK special-cases the environment variable
`STORAGE_EMULATOR_HOST` and derives its own base URL from it. Setting that _and_ passing
`apiEndpoint` makes the two configuration paths fight, and every object request 404s while
uploads appear to succeed. The config variable is therefore called `STORAGE_API_ENDPOINT`.

`fake-gcs-server` also does not serve the `storage.googleapis.com/{bucket}/{object}` path
shape, so `StorageService.publicUrl` hands out the JSON API media URL locally and the
canonical URL in production.

## Deployment

Cloud Build builds three images and deploys them. The API deploys before the public site,
since the site renders against it. The API is `--no-allow-unauthenticated` and reached by the
site's service account; the site and admin are public.

The API image uses `pnpm deploy --legacy` to flatten the workspace symlink tree — the runtime
stage copies that directory out, and symlinks pointing outside it would dangle. The public
site needs no `node_modules` at all: `ng build` bundles the SSR server and its dependencies.
