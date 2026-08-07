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
unit tests with mocks. The rewrite is one Firestore transaction, and a subtree larger than
`MAX_DESCENDANT_REWRITES` (499, the commit limit minus the node itself) is refused with 422
rather than split across several commits: a partially rewritten subtree is a set of broken
public URLs with no way back, and the depth limit makes a subtree that big a data-modelling
accident. If one ever becomes real the answer is a background re-path job behind a "moving"
flag, not a multi-batch write.

The same transaction also renumbers the destination's children: `sortOrder` in a move body is
a position, and the destination's whole child list comes back contiguous from 0, so the
position a client asks for is the number that gets stored and no client has to know its
neighbours' numbers. The commit therefore spends `1 + descendants + changed siblings` of
`MAX_TRANSACTION_WRITES` (500), and a move that would exceed it is refused with 422 for the
same reason an oversized subtree is — an order half rewritten is two children holding the same
number with no way to tell which was meant. The **source** parent is deliberately not
renumbered: a re-parent leaves a gap behind, `sortOrder` is only ever compared between children
of one parent, so a gap orders nothing wrongly and `nextSortOrder` still appends after the
highest. Renumbering it too would double the write budget of every re-parent for no observable
difference.

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

_Within one field only:_ what happens when _no_ field has text in any locale is the consumer's
decision, because the answer differs: the admin's `sectionTitle` widens to any locale that has
text and then to `(untitled)`, since a row still has to be clickable, and the public menu widens
the same way and then leaves the entry out (ADR-011), since a nameless link is not something to
show a reader.

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

### ADR-011 — The public menu promotes a visible child of a hidden ancestor

`GET /api/menu` returns only published sections with `showInMenu: true`, nested by the nearest
ancestor that is itself in that set; a section whose parent is missing from it becomes a child of
the nearest ancestor that is present, or a top-level entry. Its `href` is unchanged.

_Why:_ the alternative is that unticking one section silently deletes a whole branch of the
navigation, which looks like data loss to the admin who did it. Promotion keeps every page the
admin asked for in the menu reachable, and "hidden" covers unpublished as well as unticked with no
second rule.

_Ordering:_ the menu is built by walking the whole section tree in order and keeping the sections
that are in it, so a promoted child lands in the slot its hidden ancestor occupied and siblings
never interleave. It cannot be built from a query that filters the hidden sections out:
`sortOrder` is assigned per parent, so two sections' numbers are only comparable when they share
one, and a promoted child's number was handed out under a parent that is not there.

_Labels:_ an entry's label is the menu label, then the title, each resolved by ADR-009, then any
locale either field has text in; a section with text in no locale at all is left out rather than
served as a nameless link. So is a `link` section whose stored href fails the rule the write path
applies (ADR-012) — publishing it is a separate question from reading it, and this route is
anonymous. Both drops go through the same promotion as a hidden ancestor, so the visible children
of a dropped section keep their place.

_Cost:_ a promoted entry's `href` still contains the hidden ancestor's slug, so the URL reveals a
section that has no menu entry of its own — acceptable, since the path is where the page really
lives. And the public menu reads every section rather than only the ones it shows, which is one
bounded read of a collection the admin tree already reads whole. Three consequences follow from
that read, all accepted for now:

- the menu depends on **every** section document parsing, not only the ones it shows, so one
  unparseable document anywhere in the collection 500s the anonymous navigation. No API path can
  write one — `sectionSchema.parse` runs on every create, update and move — but the blast radius
  is wider than it was while Firestore filtered the query.
- a collection over `MAX_TREE_SECTIONS` answers the public menu with the same 422 the admin tree
  gets, which takes the navigation down entirely rather than degrading and quotes an internal cap
  to anonymous readers. Serving the public route a truncated tree while the admin keeps refusing
  is the cheap improvement if it ever matters.
- `GET /api/menu` is two Firestore reads per request, one of them up to 1001 documents, on the
  route the SSR site will call on every page view. A short-TTL memo of the built menu per locale
  is the whole fix. **There is no issue filed for it** — it is unfiled follow-up work, and the
  first consumer is Phase 2.

### ADR-012 — Validation of a stored document is looser than validation of a request

A rule **tightened after documents already exist**, on a value the document is not addressed or
routed by — the href rule on `linkTargetSchema` is the first — lives on the input schemas
(`createSectionSchema`, `updateSectionSchema`, and the admin validators that parse through the
same schema), not on the schema the repository reads documents with (`storedLinkTargetSchema` is
what `sectionSchema` names instead).

That condition is the whole rule, and shape rules on the stored schema are the norm without it:
`slug` stays kebab-case and `path` still has to start with `/` on `sectionSchema`, because a
document whose path is not a path cannot be served, linked or repaired into place — there is no
useful lenient reading of it, so failing loudly is the useful outcome. Structural rules a document
cannot be useful without, like a section's `depth` matching its ancestor chain, stay for the same
reason.

_Obligation:_ reading leniently is not permission to publish. A projection that hands a stored
value to a client re-checks it against the input schema and drops what fails — `buildMenu` leaves
a section whose stored href the write path would refuse out of the menu. Otherwise the leniency
that keeps a bad document repairable also serves `javascript:alert(1)` to every anonymous reader.

_Why:_ a repository parses on read so a malformed document fails loudly instead of flowing into a
response. But when a rule is _tightened_, documents that predate it already exist, and refusing to
read them takes down every route that touches the collection: one section with an href written
before the rule 500s the public menu, the admin tree and that section's own edit screen at once —
so the only screen that could repair it is one of the casualties, and deleting the section is the
only way out.

_Cost:_ a value the write path refuses can still be read back and re-saved by an edit to some
other field, so tightening a rule does not clean up existing data on its own. A migration is what
does that; the rule only stops new ones arriving.

### ADR-013 — The section tree owns its drag gesture; CDK only sorts

The admin's section tree is **one** `cdkDropList` — the `<ul>` — and CDK is left in charge of one
thing: sliding rows apart to show where a vertical drop would land. The other half of the gesture,
re-parenting by dragging a row into the narrow nest strip along the right-hand edge, is hit-tested
by `SectionsPage` itself: a **capturing** `mousemove`/`touchmove` listener on `window` reads the
pointer before CDK's own document-level handler does, and the pointer is tested against the rows'
**live** rectangles, so the row that highlights is the row the tree is drawing under the pointer.
While the pointer is in the strip, `sortPredicate` refuses every slot and the translations the sort
has already written are cleared, so the tree stands still in its resting layout for as long as the
pointer hunts along the strip. A release therefore means exactly one of three things: re-parent onto
the highlighted row, reorder to the slot the placeholder was holding, or — in the strip with no
legal row under the pointer — nothing at all, with no request and no toast.

Every decision in that gesture is a pure function in `sections.model.ts` with its own unit tests
(`isInNestStrip`, `rowBandAt`, `isSiblingSlot`, `siblingPositionAt`, `canMoveInto`, `applyMove`).
The component measures the DOM and dispatches; it decides nothing itself.

_Why not the obvious arrangement_ — a `cdkDropList` per row, connected through a
`cdkDropListGroup`, which is what the CDK docs point at for connected lists and what this issue
planned and tried first. It cannot be made to work, for three independent reasons. All three are
`@angular/cdk` **22.1.0** internals, so they are pinned to that version and are worth re-checking on
an upgrade rather than assumed permanent:

- `CdkDropList` declares `{ provide: CDK_DROP_LIST_GROUP, useValue: undefined }`, so a drop list
  rendered inside another one resolves no group, joins no sibling set, and silently never receives.
- `cdkDropListLockAxis="y"` — the natural way to stop a tree row wandering sideways — freezes the x
  coordinate CDK searches sibling containers at, at the drag handle. The strip is at the other end
  of the row, so no column is ever a candidate.
- `DropListRef._canReceive` tests the pointer against a `_domRect` cached once at drag start. CDK's
  own sort translates every sibling of the dragged row, and a translated row is then in two places
  at once — the cached rectangle it has left and the one it now occupies — satisfying neither half
  of that test. The rows an author most wants to nest under, the dragged row's own siblings, were
  precisely the ones that could never be entered.

_What is not covered:_ the third cause has a reflow variant that only a real browser produces.
Entering a per-row list pulls the dragged row out of the tree, the tree loses a row's height,
everything below slides up, and the column moves out from under the pointer — at some viewport
widths and not others. The admin suite does drive real CDK, over a supplied layout that re-measures
each row through the transforms the sort writes, and that reproduces the cached-rectangle failure
and the axis lock; it cannot model reflow, because jsdom lays nothing out. So a green suite is not
evidence that this gesture works end to end, and the manual checks the issue's plan names stay
manual.

_The rule for the next tree UI:_ copy this shape, not `cdkDropListGroup`. The strip machinery lives
inside `SectionsPage` only because it has one consumer; the second one is the trigger to lift it
out, along with the pointer geometry in `sections.model.ts`, rather than to copy it.

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

Uploaded media lands at `<prefix>/<yyyy>/<mm>/<uuid>.<ext>`, with the year and month in UTC and
the extension derived from the content type, never from the uploaded filename — so a caller
cannot choose the name an object lands under, and two uploads of `intro.mp3` cannot collide.
Nothing indexes these objects yet: the sweep for orphans that ADR-004 anticipates has to walk the
prefix a month at a time and match paths against `data-asset-path` in published content.

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
