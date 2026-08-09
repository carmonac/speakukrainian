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

A page's `path` is derived from its section's, so the same transaction also rewrites `path` on
every page under the subtree. A commit therefore spends `1 + descendants + changed siblings +
pages`, and a section whose subtree holds more pages than the budget left over is refused with
422 for the same reason an oversized subtree is: half the pages moved and half left behind is a
set of broken public URLs with no way back. Rewriting them in a second write after the section
transaction committed would produce exactly that state on any crash between the two, which is
why it rides along instead.

The pages are found with one range query on `path` — `>= '<sectionPath>/'` and
`< '<sectionPath>0'`, the byte after `/` — which catches the descendant sections' pages too,
and it is projected to `path` alone. Two things follow, both wanted: the rewrite drags no rich
text bodies through the transaction's 10 MiB limit, and it never parses a page document, so one
page whose body no longer satisfies its schema cannot make its section unrenameable. The write
is a single-field `update` and it **does** stamp the audit, unlike a renumbered sibling: the
page's public URL really did change, which is something an author can see, where a `sortOrder`
is not. Deleting a section that still holds pages is refused with 409, as one with subsections
already is.

### ADR-003 — Rich text is stored as sanitized HTML

Not Markdown, not a portable-text JSON tree.

_Why:_ the content genuinely needs embedded audio players, images and tables. HTML is what the
editor produces and what the renderer consumes, with no lossy conversion in between. Markdown
cannot express an audio node without falling back to raw HTML anyway.

_Cost:_ HTML must be sanitized on write, server-side. The admin sanitizes for immediate
feedback, but a compromised browser can post anything, so the API sanitizes again and that is
the check that counts.

Only the rich text fields are sanitized. Plain localized fields — a section's `title` and
`menuLabel`, a page's `title`, `seo.metaTitle` and `seo.metaDescription` — are stored
**verbatim**, because DOMPurify parses and re-serializes, so running plain text through it
would store `Tom &amp; Jerry` and every editor and every renderer would show the escape.
The obligation that buys is on the read side, and it is stricter than ADR-012's: these
values may only ever reach an **escaped** context — Angular interpolation, or an attribute
set through the DOM — never `[innerHTML]`, and never a `<script type="application/ld+json">`
block without JSON string encoding. That last case is the one where the assumption stops
holding: JSON-LD is a plausible feature on a site whose reason to exist is SEO, `</script>`
inside a JSON string ends the block, and no sanitizer upstream will have removed it.

### ADR-004 — Audio is a first-class editor node

`audio.extension.ts` defines an atom node rather than letting authors paste raw `<audio>` HTML.

_Why:_ this is a language-learning product — pronunciation clips are core content. A real node
is selectable, deletable and serializable like any other block, and it carries the storage
object path, which is what lets us find and collect orphaned uploads later. That path in the
HTML — not the body's asset arrays — is what an orphan sweep may read; see "Data model" below
for the rule and the fields it protects.

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

_Object layout._ The adapters mirror the library's own `FileContentStorage` and
`FileLibraryStorage` exactly, so its path assumptions hold: `h5p/content/<contentId>/h5p.json`,
`content.json` and the package's content files with their `content/` prefix stripped, and
`h5p/libraries/<Machine.Name-major.minor>/…`. `h5pContent.storagePath` stores
`h5p/content/<contentId>` without a trailing slash. Everything is under `h5p/`, which the media
orphan sweep does not look at.

_Temporary files._ `h5p/temp/` is reserved for the Cloud Storage `ITemporaryFileStorage` the
authoring widget needs — a temp file written by one Cloud Run instance is invisible to the
next. Phase 1 uses a local directory under `H5P_TEMP_DIR` for it, which is safe only because
nothing on the import path touches temporary storage: the package importer writes straight to
permanent storage. The editor's save flow must not ship before that placeholder is replaced.

_IAM._ These adapters are the first code in the repo that calls `storage.objects.list` and
deletes objects in bulk, so the Cloud Run service account needs `roles/storage.objectAdmin`
(or `objectViewer` + `objectCreator` + `objectUser`), not merely create-and-read.
fake-gcs-server has no permissions model, so no local test can catch a missing grant.

_Client assets._ Joubel's browser-side core and editor are **not** shipped by
`@lumieducation/h5p-server`; they are two separate repositories that npm does not carry.
`scripts/fetch-h5p-core.ts` downloads them from two pinned **commits** — the repositories' tags
are WordPress `wp-*` release tags that do not track the `h5pVersion` the library reports — and
verifies a sha256 over the _extracted tree_ rather than over the archive, because GitHub's
`codeload` zips are not byte-stable across re-encodings. It runs from the root `postinstall` and
from the API Dockerfile, and the trees are never committed. A download that does not happen is a
warning and exit 0, so `pnpm install` works offline; bytes that are _wrong_ always exit 1, and
`--require` (which the Dockerfile passes) collapses the first case into the second. The root
`postinstall` also skips when the script itself is not on disk: pnpm runs the root project's
lifecycle scripts even under `--filter`, so it fires inside the admin and web images too, whose
build context is package manifests and nothing else — and neither of them has anything to do with
H5P. The API image, which does, opts in by copying the script and then re-running it with
`--require`, so a skip there is still a failed build. Assets that
are missing at boot are a `WARN` and a 503 from `GET /api/h5p/core/*` and
`GET /api/h5p/editor-assets/*`, never a crash — the rest of the API has nothing to do with H5P.

_Base URL._ Every asset URL in a player model is generated from `H5P_BASE_URL`. It must be
**absolute** wherever the page's origin differs from the API's, which is every local development
setup: the admin runs on :4200 and a relative `/api/h5p/core/js/h5p.js` resolves against :4200 and
404s. In production both are one origin and the relative default is correct. `editorLibraryUrl` is
overridden to `/editor-assets` because its default, `/editor`, is where the editor _model_ route
goes — two different things one line apart in the URL space, and the collision would be silent.

_Player language._ `GET /api/h5p/play/:contentId` accepts `?lang`, and **the player's own chrome
renders in English whatever is asked for** — including `uk`. `H5PPlayer` localizes its labels
through a `translationCallback`; `h5p.module.ts` passes none, so the constructor's English-only
default is what runs. That is recorded here rather than fixed because fixing it is not a wiring
change: `@lumieducation/h5p-server` ships client translations for 29 locales and **Ukrainian is not
one of them** (nor is it among the 28 server-side ones), so wiring the callback would get `es` for
free and still render English for this product's own language, which needs strings we write and
then maintain. The parameter is accepted and threaded through so that doing it later changes the
module and not the route or its callers. Exercise _content_ is unaffected — that comes out of the
uploaded package. The e2e suite pins the English chrome, so the day a callback is wired the test
that fails is the one that says so.

_Who may read H5P content._ `GET /api/h5p/play/:contentId` and `GET /api/h5p/content/:contentId/*`
are `@Public()`. **What protects them is the unguessable id, not publication state**, and that is a
decision rather than an oversight: `h5pContentSchema` has no published/draft field, and
`h5pContent.pageId` is written as `null` and never set, so "is this exercise on a published page?"
is not answerable from the data today. Content ids are `randomUUID()`, no public route enumerates
them, and the player model exposes only the content asked for. An unpublished exercise is
reachable by anyone who already knows its id — which, until a published page links one, is only
its author.

The invariant this places on future work: **any route that lists or searches `h5pContent` must be
role-guarded, or must filter by the publication state of the page that references it.** A stronger
guarantee than that would need `h5pContent.pageId` to be populated plus the page's `status`, and
would cost a Firestore read per _content file_ request — per image and per audio clip — so it
needs a cache and is not something to add casually.

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

### ADR-014 — Recurring slots expand in the authoring zone

A weekly recurrence is expanded into concrete documents **at write time**, walking **civil dates**
in the slot's `timeZone` and converting each occurrence to a UTC instant on its own. Nothing is
derived by adding elapsed milliseconds to the previous occurrence. That is the whole of "a 09:00
`Europe/Madrid` slot is still 09:00 after the March change": 25 March 09:00 is `08:00Z` and 1 April
09:00 is `07:00Z`, and only a per-occurrence conversion produces both. `startsAt + 7 × 86_400_000`
produces `08:00Z` for 1 April, which reads as 10:00 in Madrid — the naive implementation the
criterion exists to catch.

The conversion uses `Intl` alone, no date library. A wall clock cannot simply be offset, because
the offset in force depends on the instant being computed. So `wallClockToInstant` reads the wall
clock as if it were UTC, probes the zone's offset ±24 h either side of that — no zone transitions
twice inside 48 h, so those are exactly the offsets on both sides of any transition — and returns
the first candidate that formats back to the wall clock asked for, else the earlier one:

| Wall clock asked for | `before` | `after` | Round-trips  | Returned | Reads back as |
| -------------------- | -------- | ------- | ------------ | -------- | ------------- |
| 25 Mar 09:00 (plain) | 08:00Z   | 08:00Z  | both         | 08:00Z   | 09:00 CET     |
| 01 Apr 09:00 (plain) | 07:00Z   | 07:00Z  | both         | 07:00Z   | 09:00 CEST    |
| 29 Mar 02:30 (gap)   | 01:30Z   | 00:30Z  | neither      | 01:30Z   | 03:30 CEST    |
| 25 Oct 02:30 (twice) | 00:30Z   | 01:30Z  | both, differ | 00:30Z   | 02:30 CEST    |

So a wall clock inside the **spring-forward gap** shifts forward by the size of the gap — 02:30
becomes 03:30 — and one in the **autumn overlap** resolves to the **earlier** instant, still on
summer time. Both match `Temporal`'s `disambiguation: 'compatible'`, which is what every calendar
application does. Skipping the occurrence would break the "exact expected number of slots" promise,
and refusing the series would refuse one that is fine on the other 51 weeks.

These helpers live in **`packages/shared/src/time.ts`**, not in the API, because the admin composes
wall-clock times too: an offset-bearing ISO string needs the offset at the instant being computed,
which is the same circularity the ±24 h probe exists to break. A second copy of that arithmetic is
exactly the drift rule 1 exists to stop, on the one calculation here that is wrong by an hour for
any wall clock within ~14 h of a transition and silent about it.

Two smaller traps are load-bearing and have their own tests: the formatter uses `hourCycle: 'h23'`,
because `hour12: false` still yields `"24"` for midnight in V8 and would date every midnight slot a
day early; and `zoneOffsetMs` floors its instant to the second, because the formatted parts carry
no milliseconds and subtracting the raw epoch value returns an offset out by up to 999 ms.

A slot's **duration is absolute**, not wall-clock: each occurrence ends `endsAt − startsAt` after
it begins. Converting `endsAt`'s wall clock separately would turn a one-hour lesson into a zero- or
two-hour one on exactly one day of the year, and a zero-hour one is not a slot at all.

**Instants are stored as normalised `…Z` ISO strings.** `isoDateTimeSchema` accepts
`2026-03-30T09:00:00+02:00`, `…T07:00:00Z` and `…T07:00:00.000Z` — one instant, three spellings
that sort three different ways — and Firestore compares `startsAt` lexicographically, so an
unnormalised value silently drops out of a range query. Every instant goes through `toInstant`
before it is stored and before it is used as a query bound. _Rejected:_ storing Firestore
`Timestamp`s, which would make the ordering correct by construction but would make this the one
collection that does so; no other repository writes a `Timestamp`, and mixing representations is
worse than one normalisation helper.

Overlap rejection reads a **bounded window of one owner's slots**, `[minStart − 24 h, maxEnd)` on
`startsAt` alone, and that lower bound is complete **only because a slot may not be longer than 24
hours**. `MAX_SLOT_DURATION_HOURS` is therefore not decoration: raise or remove it and both the
overlap check and the "slots intersecting a range" read start missing slots. The write itself is a
`WriteBatch`, not a transaction — a Firestore transaction locks the documents it reads, not the
query range, so it buys nothing against a concurrent insert (the same fact `SectionsRepository`
documents about sibling slugs) — and `MAX_RECURRENCE_SLOTS = 200` sits well under the 500-write
batch limit so a series is never split across commits. **Every write this module makes is one batch
under that limit**, deleting a series included: `MAX_SERIES_DELETE_SLOTS = 500` is the batch limit
itself rather than a policy number, and a series holding more future occurrences than that is
refused instead of assembling a commit the server would reject. It is bounded there, not at the
200-occurrence creation cap, because a series can only exceed 200 through hand-written documents —
the very case the refusal exists to let an admin clean up. The Firestore emulator does not enforce
the 500-write limit, so this one is pinned by a unit test against a double that does.

**The range read answers with a bare `ScheduleSlot[]`, not the `Page<T>` every other list route
returns.** A calendar is not a cursor list: #15 draws a whole visible range at once, and half a week
followed by a `nextCursor` is not something a calendar can render. The mandatory, 366-day-capped
range is the bound that pagination would otherwise supply, and the 422 at `MAX_LIST_SLOTS = 1000` is
what replaces "fetch the next page" — the honest answer to a range holding more slots than one
response should carry is to ask for a narrower range, not to hand back a page of it and let the
caller believe the week is empty after Wednesday. This is a deliberate exception for a bounded
range read, not a second house pattern: a list route with no natural range still returns `Page<T>`
from `BaseRepository.paginate`.

`timeZone` is validated as **a zone the runtime can actually resolve**, in `packages/shared` rather
than in the API, because both halves of the field have to close: an unresolvable zone handed to
`Intl.DateTimeFormat` is a `RangeError`, and one that is merely stored is a document every later
reader trips over. The check constructs a formatter rather than searching
`Intl.supportedValuesOf('timeZone')`, whose canonical-names-only list would refuse the
backward-compatibility links (`Asia/Calcutta`, `US/Eastern`) that `Intl` resolves happily. It is on
the stored schema as well as the input one, so — as with `endsAt > startsAt` — a document that
somehow holds an unresolvable zone fails loudly on read rather than reaching a renderer that cannot
draw it.

A **fixed offset is refused** even though `Intl` accepts `+05:30` or `+23:00` wherever it accepts a
zone name, because an offset never observes a transition: a series authored in `+02:00` would drift
an hour against Madrid for half the year, quietly defeating the only reason the field exists. A zone
that genuinely has no DST is still expressible by name (`UTC`, `Etc/GMT+5`, `Asia/Kolkata`) and a
slot authored in one simply never shifts.

The refusal is written as **"a zone name starts with an ASCII letter"**, not as "the value does not
start with a sign". The first version tested `/^[+-]/` and was bypassed by `−05:30`: `Intl` reads
U+2212 MINUS SIGN as a sign too, so that offset parsed, was stored, and pinned its own formatter.
Adding U+2212 to the character class would have been right only until ICU accepted a fourth sign, so
the test asks the opposite question. It is exact in both directions, and each direction is swept
rather than argued: across all 1 114 112 code points exactly three (U+002B, U+002D, U+2212) are
accepted ahead of an offset body and `Intl` resolves nothing offset-shaped without one, so no offset
can start with a letter; and of the 418 canonical names plus every backward-compatibility link that
resolves, none starts with anything but a letter, so no real zone is refused. A test pins each half
— one sweeps every offset spelling of all three signs, the other feeds the runtime's canonical zone
list through the schema, with an explicit case for a backward-compatibility link that list omits.

**Both time-zone caches are keyed on the lower-cased zone**, and that is half of what makes them
safe. `Intl` matches zone ids case-insensitively, so `Europe/Madrid`, `europe/madrid` and
`eUrOpE/mAdRiD` all resolve — 2048 spellings of one zone, each of which was a separate entry
retaining its own `Intl.DateTimeFormat` (~15 KB) for the life of the process, reachable over HTTP by
any admin token and unbounded. Lower-cased, no two zone names differ.

The other half is structural, and it is why `timeZoneSchema` runs its two checks as **one**
refinement that returns early rather than as two chained `.refine()` calls. Zod runs every
refinement in a chain whatever failed before it, so the chained version still looked `+05:30` up —
and cached it — after the offset check had already refused it, which put the entire offset syntax
(8712 spellings across the three signs) into a set documented as bounded by the zone database. As
one check, the lookup is unreachable for anything the field refuses, so nothing but a zone name can
key it. That is the same reason the shared formatter map is bounded: every caller passes a value this
schema accepted. The _stored_ value keeps the caller's spelling — canonicalising through
`resolvedOptions().timeZone` would rewrite `US/Eastern` to `America/New_York` behind the admin's
back, so anything comparing two `timeZone` values must fold case rather than use `===`.

**Ownership is not enforced on writes in Phase 1.** Every mutating route is `@Roles('admin')`, and
that role is the whole of the check: any admin may patch or delete another admin's slot, or delete
their whole series, and `GET` is site-wide. Only _overlap_ is per-owner, because two teachers may
legitimately offer the same hour. This is a decision, not an oversight — admins are a handful of
trusted staff, and the alternative costs an `ownerId` argument through the repository, an
owner-prefixed index, and a `403` path with nothing behind it today. What would change it: teachers
administering their own calendars, or admins who are not all trusted with each other's time.
Booking is the related Phase 2 hole and is closed the other way: `booked` is excluded from the patch
schema outright, so no route can produce a slot that reads as booked with no `bookedBy`.

**A slot's `note` is localized plain text** — `LocalizedText`, not `RichText`. It is shown to a
learner, so rule 2 makes it localized; what it is not is rich, and **two reasons decide that**: this
route runs no `RichTextSanitizer` as every other rich text field's does, and `scheduleSlotSchema`
carries no `audioAssets`/`imageAssets` for the orphan sweep to read, so any embedded media would be
untracked. Size is the third reason and the weakest of them — a note filled to its bounds is ~51 KB
on the wire, so a `MAX_LIST_SLOTS` range read has a ~51 MB ceiling either way and sheer volume does
not separate rich from plain. What it separates them on is whether a bound can be written down at
all: `richTextSchema` is `z.record(localeCodeSchema, z.string())` with **no** per-entry bound, so
choosing it would have meant a note with no length limit whatsoever, plus markup overhead on top.
Rule 3 still holds: the admin authors it in `LocalizedRichTextEditor` with `[inlineOnly]="true"`
through `toPlainLocalized`/`fromPlainLocalized`, the same way `section.title` and `page.title` are
authored.

Having a bound to write down only helps if it is written down, so the note is bounded **twice**: at
`MAX_SLOT_NOTE_LENGTH` _per locale_, so a sixth translation never invalidates text already authored
in five, and at `MAX_LOCALES` _entries_. The second bound is not optional decoration — a per-locale
bound on a `Record<LocaleCode, string>` bounds nothing on its own, because a caller can invent
locale codes indefinitely, and 500 characters under each of a few hundred of them is a note of any
size they like, multiplied by a recurrence on write and by `MAX_LIST_SLOTS` on read. `MAX_LOCALES`
is reused rather than a number chosen for this field: a note can only usefully hold a translation
for a locale that exists, and the locales route refuses to create more than that, so nothing this
refuses could have been authored. It is the cap and not the live locale count, which would cost a
locales read on every write and would fail a stored note the day a locale is deleted. The same
reasoning applies to every other localized field, and none of them enforces it yet.

_Cost:_ a slot straddling a transition ends at a different local time than the anchor did; a
document hand-written with a duration over 24 h is invisible to the overlap check; and overlap
rejection is best-effort under concurrency, repairable by cancelling one of the two slots.

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

**The stored HTML is the source of truth for which assets a page references; `body.audioAssets`
and `body.imageAssets` are a convenience index.** They exist to supply the metadata the HTML
cannot carry — `contentType`, `sizeBytes`, the storage `path` behind an image `src` — and they
are incomplete by construction: only `rich_text` bodies have them at all. The other two rich text
fields, `subsection_list.intro` and `h5p_exercise.explanation`, live on `strictObject` bodies with
**no asset array**, so a clip embedded in an intro is recorded nowhere but the content. A sweep
that decides what is orphaned by reading `body.audioAssets` would therefore delete audio a
published page still plays.

The rule that replaces it is not about page bodies: **a sweep reads every rich text field and
every `assetRef` of every page _and every section_**, and consults the index only for what those
do not say. A section is not a body, which is what makes that half of it easy to miss. The stored
fields that can hold a storage path today:

- `pages` — `body.content` (`rich_text`), `body.intro` (`subsection_list`) and `body.explanation`
  (`h5p_exercise`), all rich text; the `seo.ogImage` asset ref; and `body.audioAssets` /
  `body.imageAssets`, the index over `content` alone.
- `sections` — `description`, rich text edited with the same full-toolbar
  `LocalizedRichTextEditor` an intro uses, so it carries embedded clips just the same; and the
  `image` asset ref.

That list is a snapshot. The definition is `richTextSchema` and `assetRefSchema` in
`packages/shared/src`, and grepping for those two names is how to re-derive it — a new field of
either type is a new place the sweep has to look. (`h5pContent.storagePath` is outside all of
this: those files live under `h5p/` and belong to `@lumieducation/h5p-server`, not to the media
uploader.)

**Images degrade worse than audio, and worst where there is no index at all.** The tiptap `Image`
node writes only `src` and no `data-asset-path`, so no scan of the HTML can see an embedded image
anywhere. In a `rich_text` body that is still recoverable: `imageAssets` holds the path. In
`intro`, `explanation` and `section.description` there is no index _and_ no path attribute, so
nothing in the document states the path — the only trace left is a `src` URL, and turning that
back into a path means reversing however the environment serves the bucket
(`StorageService.publicUrl` answers differently under fake-gcs and in production). An image
embedded in an intro is therefore findable by neither half of the rule above, which makes it the
case a sweep deletes silently while a published page still displays it. Until the node gains its
own path attribute (`page-assets.ts` describes the fix and why the sanitizer would let it
through), no sweep should collect an image on the strength of the content alone.

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
