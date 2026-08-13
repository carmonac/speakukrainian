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

_Temporary files._ The editor's scratch storage is `h5p/temp/<ownerId>/<filename>` in the bucket,
not a directory on the container — a temp file written by one Cloud Run instance is invisible to the
next, and the filesystem is discarded anyway. **The owner is a path prefix rather than an
attribute**, because `ITemporaryFileStorage` forces it: every access names its owner
(`fileExists(filename, user)`, `getFileStats`, `getFileStream`, `deleteFile(filename, ownerId)`) and
a filename is unique only _within_ an owner — `FilenameGenerator` produces
`images/image-aB34xQz9.png` and checks uniqueness through `fileExists(f, user)`. Being part of the
key is what makes one editor unable to read another's upload.

**Expiry is derived, not stored:** `expiresAt = createdAt + temporaryFileLifetime`.
`TemporaryFileManager.addFile` is the only caller of `saveFile` in the library and always passes
exactly `now + temporaryFileLifetime`, so the expiry is a pure function of the write time and one
constant; storing it too would put a derived value in a second place that can disagree with the
first. `StorageService.list` already returns `createdAt`, so `listFiles()` costs one listing and no
extra round trips. The named cost is that changing `temporaryFileLifetime` re-dates every temp object
already in the bucket, which for objects whose whole life is two hours is not a defect. **An object
whose creation time the listing did not carry is skipped rather than dated**: `StorageService.list`
maps a missing `timeCreated` to the epoch so callers never see an `Invalid Date`, and an expiry
derived from the epoch is in the past for every lifetime — so reading the sentinel as a date would
have the sweep delete every object in such a listing, an author's just-uploaded clip included.
Leaking an object until a listing carries the time is recoverable; deleting a live upload is not,
because no route can put it back. The rejected
alternatives were a Firestore row (a second store that can disagree, with nothing to order the two
writes against, because the row _is_ the only record of expiry), a companion `.metadata` object
(N round trips where the derivation costs zero) and custom object metadata (needs two additions to
`StorageService` for one caller, and leans on fake-gcs-server round-tripping custom metadata through
a listing, which nothing here exercises).

_Sweeping expired temporary files._ `ContentStorer.addOrUpdateContent` passes
`deleteTemporaryFiles = isUpdate`, so on **create** — every first save of a new exercise — the temp
copies of every uploaded file are deliberately left for "the regular expiration mechanism". With
none, the rate is one permanently orphaned object per media file per newly created exercise, under a
prefix no route can enumerate or delete. The sweep is therefore **opportunistic and throttled, not
scheduled**: Cloud Run scales to zero, so an interval only runs while an instance happens to be
alive, which is precisely what nothing guarantees. `H5pEditorService.maybeSweep` runs
`TemporaryFileManager.cleanUp()` at most once per instance per 15 minutes, fire-and-forget, from the
operations that create the garbage — an instance serving an upload is an instance that is alive. It
is computed after the response and its failure is caught and logged, because an upload that
succeeded may not answer 500 because a listing failed.

**The trigger fires from `H5pEditorService`'s two mutating operations rather than from the
controller**, so it travels with the operation that creates the garbage instead of with whichever
route happens to call it. The save holds it because a **create** deliberately leaves the temp copies
behind (`deleteTemporaryFiles = isUpdate`), and `POST /ajax?action=files` keeps it because it is the
commonest source of all: a session abandoned before any save produces uploads and no save at all.
Neither may lose it, and both are asserted against real objects — an expired one is gone after a
successful operation and still there after one that threw.

One pass looks at `TEMP_SWEEP_BATCH_SIZE` objects (`StorageService.listUpTo`, one listing page) and
not at the whole prefix. `StorageService.list` refuses a prefix past its 10 000-object ceiling
rather than truncating, and `maybeSweep` swallows the rejection into a warning — so over `list` the
sweep would switch itself off exactly when the accumulation it exists to prevent had happened, and
stay off. The cost of the batch is that a listing is ordered by object name, so a prefix that stays
wider than one page is only ever swept from the start of the alphabet; every temp file expires
within `temporaryFileLifetime`, so a later pass reaches what an earlier one skipped.

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

_Staying off `api.h5p.org`._ This document previously claimed that `contentHubEnabled: false`,
`fetchingDisabled: 1` and `sendUsageStatistics: false` kept the server off `api.h5p.org` entirely.
**That was false**, and `GET /api/h5p/ajax?action=content-type-cache` was the route it was false
for: `ContentTypeCache.get()` reads `contentTypeCache` out of the `IKeyValueStorage` the editor is
constructed with, and when that holds nothing it falls through to `forceUpdate()` →
`registerOrGetUuid()`, which is an HTTPS **POST** to `hubRegistrationEndpoint` on every call.
`fetchingDisabled` does not prevent it — it is only a field in the registration payload — and the
failure is caught, so the response is still well formed and nothing is ever cached, which means it
is retried forever. What actually prevents it is that `h5p.module.ts` seeds that storage with
`contentTypeCache: []` and `contentTypeCacheUpdate: Date.now()`; `get()` short-circuits on a truthy
value and `[]` is truthy. The empty cache is not a placeholder: with `contentHubEnabled: false`
there are no hub content types, so `[]` is the truth. `addLocalLibraries` still lists every installed
library, which is what the editor's content-type selector reads.

The two seeds are independent and only one of them stops the request: `contentTypeCache` does, and
`contentTypeCacheUpdate` only feeds `isOutdated()`. So the e2e watches `https.request`,
`http.request` and `net.Socket.prototype.connect` for the duration of the call and asserts that no
host outside this machine was reached — the app runs in the test process — with a companion test
that drives a connection to a reserved name through the same probe, because an assertion that
nothing was seen is worth nothing until something can be. `outdated === false` is asserted beside
it, which is what pins the second seed. The **timestamp is honest only for
`contentTypeCacheRefreshInterval`**, one day: an instance alive longer answers `outdated: true`,
telling the editor client there are hub updates whose install action the allowlist then refuses with
a 400. No outbound request follows from it — nothing this API exposes calls `updateIfNecessary` —
so it is a misleading flag on a long-lived instance rather than a leak.

_Base URL._ Every asset URL in a player model is generated from `H5P_BASE_URL`. It must be
**absolute** wherever the page's origin differs from the API's, which is every local development
setup: the admin runs on :4200 and a relative `/api/h5p/core/js/h5p.js` resolves against :4200 and
404s. In production both are one origin and the relative default is correct. `editorLibraryUrl` is
overridden to `/editor-assets` because its default, `/editor`, is where the editor _model_ route
goes — two different things one line apart in the URL space, and the collision would be silent.

_Saving from the editor._ `POST /api/h5p/content` means **install an uploaded `.h5p` package** and
keeps meaning that, so the editor's save is `POST /api/h5p/editor` (201, the library assigns the id)
and `POST /api/h5p/editor/:contentId` (200, the id is the caller's). Two handlers rather than one,
because the statuses differ and 201 for a save over content the caller named is a lie; the noun is
`editor` because `GET /api/h5p/editor/:contentId` already means "what the editor screen needs for
this exercise". Nothing in the H5P client generates a save URL — `UrlGenerator` has no save member,
and the host page supplies `saveContentCallback` — so the path is ours to choose.

The `GET` side is one handler on **an array path**, `@Get(['editor', 'editor/:contentId'])`, and
that spelling is load-bearing twice over. Express 5 (`path-to-regexp` v8) has no optional path
parameter, so `:contentId?` throws at registration; and **two stacked `@Get` decorators register
only one route** — `RequestMapping` writes `PATH_METADATA` with a single value, so the second
overwrites the first, one path silently ceases to exist and nothing is thrown or logged. That is
worth writing down because it is silent and it will be met again. A metadata assertion in
`h5p-editor.controller.spec.ts` is what refuses the stacked form. `.optional()` on the parameter's
`documentIdSchema` is load-bearing for the same class of reason: Nest runs a param pipe even when
the parameter is absent, so a bare schema turns `GET /api/h5p/editor` into a 400.

_The editor model carries no server configuration._ `H5PEditor.render` returns
`{ integration, scripts, styles, urlGenerator }`, and `UrlGenerator`'s only serialisable own
property is `config` — the whole `H5PConfig`, **41 keys and about 1.6 KB** on an otherwise empty
model, carrying `maxFileSize`, `maxTotalSize`, `contentWhitelist`, `libraryWhitelist`,
`hubRegistrationEndpoint`, `siteType`, `uuid` and `installLibraryLockMaxOccupationTime` among the
rest. The route therefore **names its three fields** — never a spread and a delete — and its type is
`Pick<IEditorModel, 'integration' | 'scripts' | 'styles'>` and **not** an `Omit` of `urlGenerator`:
an `Omit` keeps admitting every field the library adds next, which is the same defect expressed in
the type system. The test that carries this is a substring assertion over the serialised body for
those config-only keys, in the service spec and again on the wire, because asserting the absence of
`urlGenerator` alone would pass for any future field that also holds the config.

_One fact, one sentence: the `h5pContent` document decides whether an exercise exists._ Every
authoring route that carries a content id consults it and answers `That exercise does not exist.`
— `POST /api/h5p/editor/:contentId`, because `H5pContentStorage.addContent` would otherwise let a
caller mint content under an id of their choosing; `GET /api/h5p/params/:contentId`, because the
storage adapter reaching an absent `h5p.json` raises `content-file-missing`, whose sentence names a
file the caller never named and implies the exercise is fine; and `GET /api/h5p/editor/:contentId`,
because `H5PEditor.render` reads no storage at all and would answer **200** for an id nothing was
ever stored under, handing the admin screen an authoring widget bound to an exercise that does not
exist — the author fills it in, the save 404s, and the work is recoverable only as a new exercise.
Each pays one Firestore read, and only when the caller named an id: `GET /api/h5p/editor` with no id
still pays nothing.
`MESSAGES['content-file-missing']` keeps its wording, because it is the right sentence for
`GET /api/h5p/content/:id/:file`, where a file really can be missing from an exercise that exists.

_The failed index write, and why the rollback is asymmetric._ A save writes Cloud Storage and then
Firestore — that order is forced, because the content id (on create) and the title and main library
(always) come out of what the library returns. On **create**, a failed index write rolls the content
objects back, exactly as `importPackage` does and for the same reason: without the row the objects
sit under a `randomUUID()` prefix that nothing references, no route can enumerate and no route can
delete. That is one answer to one question, so both writers call one
`H5pService.indexNewContent` rather than carrying a copy each. On **update** they are deliberately
kept: the row already names them and they are the newer
truth, so deleting them would destroy a good exercise because an audit field could not be written.
The id is logged in both branches, since that is the only thing that tells an operator which
exercise is affected. `H5pContentRepository.update` takes `{ title, mainLibrary, sizeBytes }` and
merges over the stored row — `pageId` and `storagePath` are not in its input, because a row
rewritten from a save's own fields would silently detach an exercise from its page the moment the
admin screen sets one.

_Player and editor language (amended by #36, corrected by #52)._ `GET /api/h5p/play/:contentId`
accepts `?lang` and `GET /api/h5p/editor[/:contentId]` accepts `?language`, and both select the
language of the chrome the **server** renders. One `H5P_TRANSLATE` provider builds a single
`ITranslationFunction` at boot and both `H5PPlayer` and `H5PEditor` are constructed with it. The
previous wording — that the editor half "changes nothing observable today, since no route renders an
editor model" — stopped being true when the editor-model route shipped, and this is its correction.

What the editor half reaches is `integration.l10n.H5P`, `metadataSemantics` and
`copyrightSemantics`, and no more than that: **Joubel's own authoring UI is localized by an
`editor-assets/language/<code>.js`**, one of the **26** locales upstream ships, and `uk` is not
among them (`es` is). So `?language=uk` leaves `language/en.js` in the script list —
`getLanguageReplacer` returns the identity function for a locale it does not have — and the
authoring chrome stays English, the same outcome as the player's and for the same reason.
`?language=es` swaps in `editor-assets/language/es.js`. Both are asserted, so shipping `uk`
upstream makes the claim fail rather than rot. The route validates `?language` itself with the same
pattern `/ajax` uses, because `H5PEditor.render` calls `validateLanguageCode`, which refuses a bad
code with a plain `Error` — a 500 for a query parameter the caller typed.

**Ukrainian is ours because upstream ships none.** `@lumieducation/h5p-server` carries client
translations for 29 locales and `uk` is not among them (nor among the 28 server-side ones), so
wiring the callback buys `es` and 27 others for free and still leaves this product's own language
in English. Those 29 are read once at boot from a directory listing inside the installed package —
never from a path built out of `?lang`, which is a public query string and would make a lookup a
traversal. Ukrainian lives in `apps/api/src/h5p/h5p.translations.uk.ts` as flat i18next keys and
**deliberately not** as a `LocalizedText` in `packages/shared`: these are H5P's own keys with H5P's
own values, nothing here is admin-authored and no admin screen edits it, so CLAUDE.md rule 1 does
not reach it. It is the one translation in the product that is not a `LocalizedText`.

**The fallback is per key, not per file, English last.** A key is resolved by walking our overlay
then upstream's file, for the requested locale lower-cased, then its primary subtag (`uk-UA` →
`uk`), then English. So a locale nobody ships gets English whole, a partly translated locale gets
English for exactly the keys it misses, and an empty value counts as missing — the failure mode
being avoided is a label reading `client:fullscreen`, which is what `SimpleTranslator` answers, not
`undefined`. A locale an admin adds at runtime therefore gets English chrome unless upstream ships
it. Two named consequences of resolving the primary subtag rather than mapping BCP 47 onto
upstream's filenames: `?lang=zh` gets English, because upstream has `zh-cn` and no `zh`; and
`?lang=pt-BR` is answered from `pt.json`, not from the `pt_BR.json` upstream also ships — two files
that differ in 88 of their 167 keys — because upstream spells that name with an underscore, so only
a caller spelling it the same way reaches it and the hyphen form every BCP 47 client sends falls
through to the primary subtag. (`es-MX` is unaffected only because upstream happens to ship both
spellings.) Named and not fixed: this product's locales are `en`, `es` and `uk`, and a
filename mapping table is a second thing to keep in step with the dependency. The
`metadata-semantics` and `copyright-semantics` namespaces are loaded so the editor's callback is no
worse than the default it replaces, but no Ukrainian is authored for them: they are editor-facing
and no route exposes them yet.

The Ukrainian key set is pinned against upstream's own `client/en.json` by a unit test, so an
upstream rename fails on the dependency bump that introduces it instead of silently reverting a
label to English. If the files ever fail to load — a package layout change, or an image that did
not carry them — the loader warns and the API still boots. **What it degrades to is not English but
the raw i18next keys:** `en` is an entry in the same map as every other locale rather than a floor
beneath them, so every label reads `client:fullscreen` except the Ukrainian ones, which are compiled
in. A last-resort English map compiled into this repo would make that degradation real and is
deliberately absent — it would be a second copy of upstream's 169 strings, drifting from the first
and needing its own parity test, to defend a state that today cannot arise on its own, since
`H5PPlayer` statically requires the same `en.json` and so fails to import first. The branch that can
fire alone is the package not resolving at all. The unit test is the alarm, and it fires where a
human can act on it; the warning says the same thing to whoever is reading the logs instead.

`?lang` is the caller's to choose: the public site is server-rendered and knows the reader's
locale, so it passes it, and absent `?lang` the answer is `en`. Exercise _content_ is unaffected —
that comes out of the uploaded package and is the author's to translate.

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

`GET /api/h5p/temp-files/*` is on the other side of that line and is `@Roles('editor')`, along with
`GET` and `POST /api/h5p/ajax`, `GET /api/h5p/temp/:token/*` and the four routes that load and save
an exercise — `GET /api/h5p/editor[/:contentId]`, `GET /api/h5p/params/:contentId`,
`POST /api/h5p/editor` and `POST /api/h5p/editor/:contentId`: `h5p-editor.controller.ts` is a file
boundary the way `h5p-public.controller.ts` is, and the guards are pinned per route by its metadata
block, so the enumeration invariant above is unaffected by any of them. `temp-files` in particular
**cannot** be made public, because the URL carries no owner id and a temporary filename is unique
only within an owner — an unauthenticated request has no way to say which object it means.

_The credential Joubel's own client carries (#62)._ This section previously recorded an open gap:
after `POST /ajax?action=files` the editor renders the preview as
`<img src="${integration.editor.filesPath}/<filename>">`, and a browser subresource sends no
`Authorization` header, so the just-uploaded clip did not render. The same is true of **every**
request the widget makes — `GET /ajax?action=content-type-cache`, `?action=libraries`,
`POST /ajax?action=files|translations|filter|library-upload` — because they all come from Joubel's
code inside a **srcless iframe**, a fresh realm the admin's `HttpClient` interceptor cannot reach.
That gap is closed, and the mechanism this document predicted for it was wrong in both directions.

**A short-lived, per-user, signed token in the URL.**
`base64url(payload) + '.' + base64url(HMAC-SHA256(secret, payload))` with
`payload = { v, sub: <uid>, scope: 'h5p-editor', exp }`. `base64url` because the same string has to
survive a query parameter _and_ a path segment. Signed rather than stored, and that is **forced**:
`UrlGenerator`'s `csrfProtection.queryParamGenerator` is synchronous, so the mint site cannot do
I/O.

**It carries no role, deliberately.** The token says who is asking; `H5pUrlTokenGuard` then resolves
that uid's _current_ Firebase custom claims and `@Roles('editor')` decides, exactly as for a bearer
request. So a token minted before a demotion stops working the moment the demotion lands, rather
than at the end of its lifetime. The price is one Firebase Auth read per token-authenticated
request — tens per editing session, not thousands — and an Auth outage breaks previews. If that ever
matters the answer is a short cache in the guard, **not** a role in the payload.

**Where it goes, and why it takes two mint sites.** The ajax half is the library's own lever:
`new UrlGenerator(config, { protectAjax: true, …, queryParamGenerator })` passed as `H5PEditor`'s
**seventh** positional argument, which covers both `integration.ajaxPath` and
`integration.editor.ajaxPath` without this code having to know there are two, and keeps the
`?token=…&action=` format upstream's responsibility. **No subclass is needed, and a subclass could
not have done the other half**: `IUrlGenerator.temporaryFiles()` takes **no user**
(`H5PEditor.generateEditorIntegration` calls it with no arguments), so nothing inside a generator
can bind a token to a caller. `integration.editor.filesPath` is therefore overridden in
`H5pEditorService.editorModel`, the nearest place the caller is known. One response carries two
independently minted tokens; they differ only in the millisecond they were made and nobody should
thread state through the singleton generator to make them one.

**A new route, not a segment on the old one.** `GET /api/h5p/temp/:token/*path` is a second
temporary-file route beside `GET /api/h5p/temp-files/*path`, which is untouched.
`temp-files/:token/*path` would have been wrong: it and `temp-files/*path` both match
`/temp-files/images/x.png`, and only declaration order would decide which answered — the same silent
class as the stacked `@Get` decorators above. `PATH_METADATA` for both is asserted.

**`@H5pUrlToken()` is not a second `@Public()`.** It marks the three routes that accept a URL-borne
credential _in addition to_ a bearer header. `H5pUrlTokenGuard` is registered as the **first** of
three `APP_GUARD`s — that order is load-bearing, since `FirebaseAuthGuard` would otherwise already
have refused a headerless request and a later guard cannot rescue one — and is a no-op on every
route without the marker. `FirebaseAuthGuard` gained one branch, `if (request.user) return true`,
under the rule that **`request.user` may be assigned only by an authentication guard and never from
request input**. Every route in `h5p-editor.controller.ts` keeps its `@Roles('editor')`, so the
file boundary above is unchanged; `@Public()` plus a route guard was rejected precisely because it
would have deleted those assertions and left one new guard between an anonymous caller and
`POST /ajax?action=files` writing into the bucket.

**Lifetime is `H5PConfig.temporaryFileLifetime`** — 120 minutes — read per mint rather than copied
into a setting of its own: the token exists to let the widget act for one editing session, and that
is already the library's answer to how long an editing session's scratch state lives. The named cost
of the coupling is that the same number drives the expiry sweep. **What a lapse looks like**: the
widget reads `ajaxPath` and `filesPath` once, when it mounts, and cannot refresh them, so after two
hours in one mount content-type switching, uploads and previews fail with Joubel's own error UI.
**Saving is unaffected**, because `POST /api/h5p/editor[/:contentId]` is called by the admin's
`HttpClient` with a bearer token — so the failure mode is "the widget stops fetching", never "the
author loses work", and reloading the screen mints a fresh token. Three 401 messages keep expiry
distinguishable from a bad link and from an account that can no longer sign in; **no** token at all
is not an error but "this request is using the other credential", and falls through to
`Missing bearer token`.

**What a leaked token can do, stated rather than implied.** List installed libraries, read and write
_that user's own_ temporary files, and — because `library-upload` is on the `POST /ajax` allowlist —
**install an H5P library**. It cannot save or delete content, cannot list exercises and cannot reach
any non-H5P route. The library-install capability is not removable: the widget's own Upload tab uses
it. The token appears in this server's request logs and in Cloud Run's, and is **not redacted**: a
redaction applied only to our own two log lines would imply a guarantee the platform log does not
honour. What bounds the damage is the narrow scope and the short lifetime. It does not reach browser
history (never a top-level navigation) or a third-party `Referer` (the URLs are requested only from
this origin), and `temp-files` already answers `Cache-Control: private, no-store`.

`H5P_URL_TOKEN_SECRET` is **required with no default**, at least 32 characters, and `.env.example`
ships it **empty** — so copying the example refuses the boot rather than starting every developer
and every deploy on one key published in this repository. It is a **deploy prerequisite**: the
Cloud Run service will not start until the Secret Manager entry exists, and nothing in CI can catch
that, because CI does not deploy. One secret and no key id in the payload, so rotation invalidates
every live session at once; that costs an author a reload, and rotation-with-overlap is a deliberate
future addition rather than something to discover.

_Cross-origin resource policy (recorded by #62, decided in #12)._ `helmet` sets
`Cross-Origin-Resource-Policy: same-origin` for the whole API, and the admin on `:4200` loading a
subresource from the API on `:8080` is a cross-**origin** no-cors request, which a browser refuses
against that value — 200 in supertest, blocked in Chrome. The override is **scoped to the routes
that serve subresources**, not global: `CROSS_ORIGIN_HEADERS` in `h5p.responses.ts`, spread by both
pipe helpers and set explicitly by `H5pPublicController.sendAsset`, covers content files, library
files, the core and editor client trees and both temporary-file routes — six routes. That decision
shipped in #12 and **is not reopened**: relaxing CORP globally would relax it for every JSON, media
and schedule route for no gain, and the public site on `:4300` is served by the same asset routes.
`play` and every JSON route keep `same-origin` on purpose.

Two headers that look related and are not, named so a future reader does not "fix" them:
`X-Frame-Options: SAMEORIGIN` governs a document loaded into a frame _by URL_, and the editor's
iframe is created with **no `src`** and populated through `contentDocument.write`, so there is no
HTTP response for it to apply to; `Cross-Origin-Opener-Policy` applies to top-level browsing
contexts, and this API never serves the top-level document of either front end.
`crossOriginEmbedderPolicy` stays **off**, because the public site embeds H5P iframes from this
origin.

What was actually missing was any test that would notice the override's removal.
`createTestApp` now installs the same `securityHeaders()` middleware `main.ts` does — one definition,
so the two bootstraps cannot drift — which is what turns "this route sets a header" into "this route
beats the global default"; the e2e asserts `cross-origin` on every asset URL the editor model
advertises and `same-origin` on the player model and the editor model beside it. **What that
establishes and what it does not**: it establishes what a browser _will be told_. It does not
establish that a browser loads the file — there is no browser harness in this repository, and no
test here can create one.

`GET /api/h5p/content` is that enumeration, and it satisfies the invariant by being role-guarded:
it lives on `H5pController`, where every route is `@Roles('editor')`, and the guard is pinned per
route by the metadata block in `h5p.controller.spec.ts`, so relaxing it to `@Public()` fails a unit
test rather than quietly widening the public surface.

_Deleting content._ `DELETE /api/h5p/content/:id` removes the objects under `h5p/content/<id>/`
first and the index document second, because an object must never outlive the row that names it: a
crash the other way round would leave files under a `randomUUID()` prefix nothing can name again,
and would leave "deleted" content still playable through the public play route. The sweep is
`StorageService.deleteByPrefix`, not `H5pContentStorage.deleteContent`, so that a retry after a
half-completed sweep still succeeds — `deleteContent` throws 404 when `h5p.json` is missing, which
is a state that half-completed sweep can produce. Installed libraries are deliberately left behind;
other content may use them, and collecting them is `LibraryAdministration`'s job on a screen of its
own.

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

**The second application is the localized bounds.** `localizedTextSchema` and `richTextSchema`
carry a per-entry length (`MAX_LOCALIZED_TEXT_LENGTH`, `MAX_RICH_TEXT_LENGTH`) and an entry count
(`MAX_LOCALES`); `storedLocalizedTextSchema` and `storedRichTextSchema` carry neither, and
`storedAssetRefSchema`, `storedSeoSchema` and `storedPageBodySchema` exist so the stored side of a
section and a page can reach them. The first reason is the one _Why_ gives below:
`SectionsRepository` parses
every document it reads, `GET /api/menu` reads every section, so one over-long stored title on the
bounded schema would 500 the anonymous navigation, the admin tree and that section's own edit
screen at once — and unlike a bad href, an admin facing that has no way to learn which of N
sections is the offender. The second reason is specific to this rule and does not need a legacy
document at all: **`RichTextSanitizer` runs after the pipe and can grow a value**, since DOMPurify
re-serializes what it cleans (`&` becomes `&amp;`, `controls` becomes `controls=""`). A body that
passes at exactly the bound is therefore stored over it, and a bounded stored schema would make the
API refuse to read a document it had just written, with no attacker involved.

_The split fixes the read half of that, and only the read half._ A page whose sanitized body ended
up over the bound reads, renders and can be repaired — but it cannot be saved again with its body
unchanged. The admin sends the whole `body` on every save, so a title-only edit on that page answers
400 at `body.content.en`, and the toast the admin raises drops the issue path, so it does not name
the field or the locale. The bound gets no slack in exchange, because the sanitizer's growth scales
with how many constructs it rewrites rather than costing a fixed number of characters, so no fixed
slack closes the window — it only relocates it — while the read-side leniency is the half worth
having. The residual is accepted because the window is `sanitized > bound ≥ raw` and its width is
exactly what the sanitizer adds to that body: **nothing** for HTML the editor serializes, since
ProseMirror escapes `&` itself and `audio.extension.ts` already emits `controls="true"` — an
editor-shaped body of 99 743 characters is stored at 99 743 and saves again unchanged — so through
the admin the window is unreachable rather than merely narrow. It opens only for a client sending
constructs the editor never emits: 1 000 bare `&` in a 99 000-character body is stored at 103 000
and refuses the next save, 5 000 of them at 119 000, which is thousands of characters wide, not a
few. Reaching it at all takes a body near a bound that already clears the heaviest page anyone could
plausibly author by 1.7× and a deliberately heavy one by ~4.5× (`common.ts` carries the
measurement), and nothing in the window is lost, unreadable or unrepairable. It is also the one case
where the admin's "a length refusal is unreachable in real authoring, so a toast is enough and
nothing is bound to a field" decision fails on its own terms — this refusal arrives on a page the
author saved successfully and did not lengthen. Closing it means re-parsing the sanitized body
against the input schema at the write boundary and refusing there, so the API never writes a body it
would not accept back; that is a follow-up issue, and it would leave this ADR's split resting on
legacy documents alone, which is reason enough on its own.

_Obligation:_ reading leniently is not permission to publish. A projection that hands a stored
value to a client re-checks it against the input schema and drops what fails — `buildMenu` leaves
a section whose stored href the write path would refuse out of the menu. Otherwise the leniency
that keeps a bad document repairable also serves `javascript:alert(1)` to every anonymous reader.

_The obligation has a limit, and the localized bounds are where it shows._ `buildMenu` is **not**
asked to drop a section whose stored title is longer than the input bound, because the two rules
protect different things: the href rule protects the _reader_ — a `javascript:` URL reaching a
browser — while a length rule protects the _store_. Dropping a navigation entry over a long label
would trade a real harm for none. So the rule is "re-check what a bad value would harm a client
with", not "re-check everything". What these bounds do not do either is make a multi-document read
small: `GET /api/pages` still returns up to 100 documents, each of which may hold rich text in many
locales, and what bounds that today is Firestore's per-document ceiling. The honest fix is a list
projection that omits page bodies — an unfiled follow-up, not something a schema bound achieves.

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
not separate rich from plain. What it separates them on is the bound that could be written down
at all: when this was decided `richTextSchema` was `z.record(localeCodeSchema, z.string())` with
**no** per-entry bound, so choosing it would have meant a note with no length limit whatsoever.
#40 has since bounded it, but at `MAX_RICH_TEXT_LENGTH` — a number sized for a lesson, which is two
hundred times a note — so the answer is unchanged, plus markup overhead on top.
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
reasoning applies to every other localized field, and **#40 applied it to all of them**:
`localizedTextSchema` and `richTextSchema` now carry the same entry-count bound plus a per-entry
length of their own. The note keeps `MAX_SLOT_NOTE_LENGTH` — two policies that happen to agree on
500, and collapsing them would tie the schedule note's bound to every title on the site — and it
keeps its bounds on the _stored_ schema, where #40 deliberately puts none: this route's note is one
optional field, so an abusive one is unreadable rather than merely unwritable, which is the
narrower version of the outage ADR-012 describes.

**A calendar drawing those slots keeps geometry on one clock and labels on the slot's clock.** The
admin's week view places a slot in the day column its `startsAt` falls on **in the view zone** — the
browser's own zone — because a grid whose columns are drawn on different clocks says two slots clash
when they do not, and says nothing at all about a free hour. The chip then labels the interval in
the slot's **own** `timeZone` and names that zone, plus the weekday when the slot's civil day is not
the column's, so a slot authored 23:30 Friday in Madrid and drawn in Saturday's column from Kyiv
reads as what it is rather than as a placement bug. Anything rendering a slot — #39's form, Phase
2's booking flow — inherits both halves: the position is a view-zone question and the label is a
slot-zone one, and mixing them is the same class of error as adding elapsed milliseconds to a
recurrence.

The second line, the same interval on the grid's clock, is drawn only when it would **say** something
the first line does not — decided on the rendered string, not on the two zone names. Comparing names
(even case-folded) is not enough, and a real browser is where that shows: **Chromium answers
`Europe/Kiev` for a machine set to `Europe/Kyiv`**, so a Kyiv admin — the product's primary audience
— stores every slot under one spelling and views it under the other, and every chip on the screen
then carries the identical interval twice. Two zones that merely share an offset for that slot
(`Europe/Madrid` viewed from `Europe/Paris`) read the same way, and the decision is per slot at
render time, so `America/Phoenix` viewed from `America/Denver` correctly draws one line in January
and two in July. This is not the canonicalisation the paragraph above refuses: no stored value is
rewritten, no link is resolved, and the case-folded `sameZone` stays as the cheap path in front of
it.

_Cost:_ a slot straddling a transition ends at a different local time than the anchor did; a
document hand-written with a duration over 24 h is invisible to the overlap check; and overlap
rejection is best-effort under concurrency, repairable by cancelling one of the two slots.

### ADR-015 — One JSON body limit, sized by what one document can hold

`MAX_JSON_BODY_BYTES` is **1 MiB**, and it is derived rather than picked. Two independent anchors
agree on it. Media is uploaded separately and referenced by absolute Cloud Storage URL, so no body
carries base64, which is what keeps a page body in the hundreds of KB:

| body                                                       | bytes       |
| ---------------------------------------------------------- | ----------- |
| typical rich text page, 3 locales                          | 48 KB       |
| typical rich text page, 10 locales                         | 152 KB      |
| heavy page (40 paragraphs, 30 audio, 12 images), 3 locales | 169 KB      |
| heavy page, 10 locales                                     | **539 KB**  |
| `subsection_list` page with a rich intro, 3 / 100 locales  | 9 / 152 KB  |
| section with a rich text description, 3 / 100 locales      | 12 / 201 KB |

1 MiB is ~2× the heaviest body worth calling realistic. And every JSON route here writes at most one
Firestore document per request, which may not exceed **1,048,576 bytes**; measured against the same
objects, the JSON body is consistently 1–2% _larger_ than the document it becomes, because JSON pays
two quotes and escapes per string where Firestore pays one byte. So a body over this limit
essentially cannot produce a storable document. Express's 100 KB default clipped the _typical_
three-locale page, which is how this surfaced. _Rejected:_ 512 KiB, which clips the heavy ten-locale
page; 1,000,000 decimal bytes, which buys a strict "accepted ⇒ storable" guarantee for 1% of headroom
at the cost of the house `formatMax…Size` convention; and an env var, since a limit quoted in a
user-facing message cannot vary per deployment without the message going stale.

The residual band — a body just under 1 MiB that parses and then produces a document marginally over
Firestore's ceiling — is left as it is: a 500 from the write. It is **not** closed by the localized
bounds #40 added: `MAX_LOCALES × MAX_RICH_TEXT_LENGTH` is 10 M characters, far more than a document
can hold, exactly as the paragraph below anticipated. Closing the band would need per-field bounds
tight enough to add up to under a document, which no field has a reason to carry; what keeps a
single request small remains this ADR's own body limit, which cannot see the `id`, `path`,
`publishedAt` and `audit` fields the server adds.

**One limit, and a route that needs more gets its own parser.** Not a raise of this one: the body is
buffered in middleware, ahead of `FirebaseAuthGuard`, so every byte of it is reachable by an
unauthenticated caller. A second value would also be a second place for the number and its wording to
drift.

**Multipart is bounded separately, and the two 413s deliberately say different things.**
`express.json()` claims only `application/json`, so the media and H5P routes still go through multer
at `MEDIA_UPLOAD_RULES` and `MAX_H5P_UPLOAD_BYTES`. Telling someone whose 60 MB mp3 was refused that
"request bodies must be under 1 MB" would be actively misleading. They cannot collide — different
content types, different middleware. `MAX_LIST_SLOTS` is a different axis again: a read-side ceiling,
not a write-side one.

**The limit is installed by one helper that both bootstraps call** — `main.ts` and
`test/emulator.ts` — because an e2e suite running at a different limit tests a server that does not
exist. Both create the application with `bodyParser: false`: `useBodyParser` only _appends_ a parser,
so if Nest's own defaults are already in the middleware stack the raised limit is dead code. Nest
happens to skip its defaults when a parser of the same function name is already installed, so the
current call order survives without the flag — and that is exactly why the flag is there: the skip is
a name comparison in a third-party file, conditional on a call order neither bootstrap is obliged to
keep, so we kept the belt because the braces are not ours. The helper runs **after** `enableCors`, so
the 413 carries `Access-Control-Allow-Origin`
and the admin's `fetch` reports a status rather than an opaque network failure.

**`HttpExceptionFilter` maps a non-`HttpException` to a 4xx only when `expose === true`.** Errors
raised in middleware never reach a controller, so an oversized body arrived at the filter as an
unrecognised throw and was reported — and logged with a stack — as a server fault. The fix is
narrower than "carries a 4xx status", because a status alone over-matches: `GaxiosError`, what
`@google-cloud/storage` throws, copies the upstream response's status onto itself, so a bucket 403
for a lost IAM role would be reported to the caller as their mistake. `expose` is `http-errors`' own
"safe to show a client" flag and nothing else in this tree sets it, so **a storage outage is still a
500**. The message answered from that branch never comes from the exception — body-parser attaches a
fragment of the request body to its parse failures — and it logs one `warn` line with no stack.

**Malformed JSON is answered with Nest's parse message, which reflects a fragment of the caller's own
body.** It does not reach the branch above: `mapExternalException` converts the `SyntaxError` into a
`BadRequestException` before the filter is entered, so `{"password":"hunter2","x":}` is answered
`Unexpected token '}', ..."ter2","x":}" is not valid JSON`. Accepted rather than fixed. Suppressing it
would mean overriding `mapExternalException`, because at the filter that exception is
indistinguishable from a `BadRequestException` a controller threw; what is reflected is the caller's
own input returned to the caller, on an `application/json` response; and no error path in either
front end has an HTML sink — the only `[innerHTML]` in the admin is the sanitised rich text preview.
Written down because the alternative is someone rediscovering it as a leak, and because the filter's
own 4xx branch makes the opposite promise for the errors it does map.

**#40 and this limit are different layers, and both are load-bearing.** The body limit runs in
middleware, before Zod; #40's per-entry bounds run in the pipe, after. An over-long single field now
gets a 400 naming the locale, which is a better error — but only for bodies that fit.
`MAX_LOCALES × MAX_RICH_TEXT_LENGTH` is 10 M characters, so #40 does not treat the body limit as its
bound and this limit is still what refuses a body no field bound would.

_Cost:_ an unauthenticated caller can make the API buffer 1 MiB per connection instead of 100 KB.
Accepted: parsing after authentication is not available in this architecture, Cloud Run caps requests
at 32 MiB regardless, and 1 MiB in flight is small next to the 100 MB the H5P upload route already
accepts.

### ADR-016 — Media uploads are accepted on their bytes, not their declared type

**The content type declared on a multipart part is not evidence of anything.** A browser derives
`File.type` from the filename extension, so `cp notes.txt notes.mp3` is declared `audio/mpeg` and
passed every check the media routes had: the object was stored and the editor inserted a silent
`<audio>` node. The decision is now made by the file's **leading bytes**, and the declared type is
accepted only if the bytes can be that type.

**The rule lives in `packages/shared` (`media-signatures.ts`), so the admin's pre-check and the API's
check are literally the same function.** The allow-list was already shared for that reason and the
byte check has the same failure mode if it drifts. The admin reads the first `MEDIA_SIGNATURE_BYTES`
of the file and refuses locally; that is a courtesy, and the API's check is the guarantee. They share
the precedence as well as the rule — type, then bytes, then size at both ends — but that is
housekeeping rather than a user-visible fix: `limits.fileSize` aborts an oversize part before the
handler runs, so a file that is both oversize and the wrong format comes back 413 from the API
whichever way the service's own checks are ordered. Matching them keeps the defence-in-depth branch
reading the same way as the admin's, so neither end carries a divergence to re-justify.

**The table is hand-written rather than a dependency.** Anything in `packages/shared` ships into the
admin bundle and the SSR site, and the check is a comparison of ≤12 header bytes for nine formats.
`file-type` is a streaming tokenizer for hundreds of formats we refuse, and its MIME strings do not
line up with ours anyway — `.m4a` and `.mp4` are one container, a WebM's audio-only-ness is not
decidable from its header — so the container → allowed-types mapping and the specs pinning it would
have to be written regardless. Confining the dependency to the API instead would mean the two ends
checked different things.

**A tagless MP3 is decided by decoding its frame header, not by its sync word.** Every other entry in
the table is a literal magic; MP3 without an ID3 tag has only the 11-bit frame sync, and that is not
enough to decide anything — `FF FE` is the UTF-16LE byte-order mark, so a text file saved as
"Unicode" and renamed `.mp3` passed. The version, layer, bitrate and sample-rate fields are read as
well, and every one of them has to be a value an MPEG audio frame can hold; Layer III is required,
since a file offered as an MP3 is never Layer I or II and admitting them would readmit the BOM. That
is the tightest rule in the table and therefore the one most likely to refuse a real file, so it is
pinned both by fixtures written from the spec and by the leading bytes lame and ffmpeg actually
write, across all three MPEG versions.

**The ID3 rule reads the whole 10-byte header for the same reason.** Three ASCII letters were the
loosest claim left in the table once the frame sync had been tightened, so the version and revision
bytes — where `FF` is reserved — and the four size bytes — stored synchsafe, so their high bits are
always clear — have to hold values a tag can, and all ten have to be there. That costs nothing
against real files, because every tag carries the full header whatever revision it is. The flags byte
is deliberately not checked: v2.2, v2.3 and v2.4 each define a different set of bits, so refusing an
unknown one would refuse a future revision rather than a renamed text file.

**Detection reports a container, and the declared type is what gets stored.** `iso-bmff` and `ebml`
cannot choose between the audio and the video type, so the bytes prove "this is an ISO-BMFF file" and
the allow-list supplies the only thing we accept that it could be. Deriving the stored content type
from the bytes would mean hard-coding that same mapping and calling it a derivation, so
`buildObjectPath` keeps deriving the extension from the declaration — corroborated, now, rather than
trusted.

**The check runs in `MediaService.upload`, not in `fileFilter`.** Busboy calls the filter on the
part's headers, before a byte has been read, so it keeps the declared-type gate and nothing more —
that gate is still what stops an unsupported type from being buffered at all. Media uses multer's
memory storage, so by the time the handler runs the file is in `file.buffer` and **nothing has been
written anywhere**: a rejection has no partly-written object or temp file to unwind, unlike the H5P
package scan, whose upload is on disk before it can be examined. A future media route wired with disk
storage would hand the check no buffer and be refused, which is the direction to fail in.

**`image/svg+xml` is dropped.** An SVG is plain text with no signature, so keeping it would mean a
second, differently-shaped guard — declared type plus an XML parse of attacker-controlled bytes — for
a format nothing in this product uses. It also closes the standing obligation the old allow-list
comment carried: an SVG can carry script, which runs with the origin that served it, harmless while
media is served from the bucket and a session-stealing hole the day it is served from ours. Nothing
on a read path consults the allow-list — `assetRefSchema.contentType` is an unconstrained string — so
an already-stored SVG still parses, renders and resolves; only new uploads are refused. Re-adding SVG
means sanitizing the bytes on upload, which was always the right guard for it, not exempting it from
this one.

**Two things are deliberately left open.** The first is that a header is all that is read, and for
MP3 that leaves the reported case narrowed rather than closed. The ID3 rule wants ten bytes whose
version and revision are not `FF` and whose four size bytes have their high bits clear — and every
ASCII byte satisfies all of those, so plain text beginning `ID3` and at least ten bytes long is a
structurally valid tag header. `printf 'ID3 is a metadata container used by MP3 files.' > notes.mp3`
declared `audio/mpeg` gets a 201, a stored object and a silent `<audio>` node, exactly as
`cp notes.txt notes.mp3` did before this change. What the rule does refuse is text that does not
begin with those three letters, and binary junk, since arbitrary bytes readily land on a reserved
`FF` or a set high bit in the size. Garbage _behind_ a well-formed header is open in the same way and
for the same reason: the frames after an ID3 header are never read, and deciding playability needs
decoding rather than header inspection.

The second is that a container header proves the **box structure, not the payload**. `iso-bmff` is
the sharp case: the check is `ftyp` at offset 4 and nothing more, so `ftypheic`, `ftypqt  `,
`ftypjp2 ` and `ftyp3gp4` all satisfy `audio/mp4`, and a `photo.heic` renamed to `.m4a` gets a 201
and a silent `<audio>` node — the same product harm the issue reported, reached by a deliberate
rename rather than an accidental one. An MP4 or WebM carrying a video track is the same residual in
its milder form: it is accepted, lands in an `<audio>` element and plays its audio track. Both are
content-quality outcomes rather than security ones.

_Rejected: an allow-list of ISO-BMFF major brands._ The set that is legitimately audio or MP4 is long
and open-ended — `M4A `, `M4B `, `mp41`, `mp42`, `isom`, `iso2`, `iso4`, `mmp4`, `dash`, `f4a `, and
`qt  ` from some muxers — so an allow-list closes a narrow, deliberate misuse while adding the one
risk this whole change carries: refusing a real file from a muxer nobody tested against.

_Rejected: a custom multer storage engine that inspects the first chunk and aborts at 16 bytes._ It
would have to reimplement `memoryStorage`'s buffering and error propagation, and the only saving is
buffering up to `limits.fileSize` of a file that is refused a moment later — a bound every upload
already has. Worth revisiting if media limits grow to video sizes.

### ADR-017 — What `HttpExceptionFilter` guarantees

The filter is the last thing in the request path, so everything below is a promise nothing above it
has to repeat. It had two gaps, and both had the same shape: **the carefulness lived in the caller.**

**What reaches the client.** One JSON envelope, always: `{ statusCode, message, path, timestamp }`,
plus `errors` when the payload carried one — the Zod pipe's issue list is the only producer today. An
unrecognised throw is a generic 500 whose `message` is the constant `Internal server error`, so a
storage outage or a Node built-in never puts its own wording, let alone its stack, on the wire. An
`HttpException`'s payload is forwarded as it stands, **5xx included**: a `ServiceUnavailableException`
telling a developer to run `pnpm h5p:fetch` is only useful if the sentence arrives. That is unchanged
by the logging below, and pinned by a case that asserts the body of a 500 is byte-for-byte what it
was. ADR-015 records why a non-`HttpException` becomes a 4xx only when `expose === true`, and why
that predicate is not keyed on the status alone.

**What is logged, and at what level.** Three rules, and the asymmetry between them is deliberate:

| what was thrown                    | log                       |
| ---------------------------------- | ------------------------- |
| middleware 4xx (`expose === true`) | one `warn` line, no stack |
| `HttpException`, 4xx               | nothing                   |
| anything 5xx                       | `error`, with the stack   |

A 4xx `HttpException` is the caller's mistake and the routine vocabulary of a working API — a line per
rejected validation is noise that buries the lines that matter. A 5xx is this server's, and by the
time it arrives here the filter is the last thing that can record it; `throw new
InternalServerErrorException(…)` used to produce a 500 the client saw and no record at all on the
server, which is the one case where the log is the only evidence the failure happened. The middleware
4xx does get its `warn` because it was raised before any of our code ran, so nothing else has the
chance to say it happened; a `BadRequestException` came from code that could log if it had anything
to add. The threshold is `>= 500`, not `=== 500`: the only 5xx `HttpException` in the tree that did
not already log by hand is a **503**, the one `GET /api/h5p/core/*` answers on a server whose client
trees were never fetched — what an offline `pnpm install` leaves behind.

**The two H5P sites keep their own lines, on purpose.** `h5p.errors.ts` and the `sendFile` path in
`h5p-public.controller.ts` both log and then throw a _sanitized_ exception, so what the filter is
handed no longer carries the cause: the `H5pError`'s `debugMessage`, and the requested path plus
`send`'s own `EACCES`, are discarded to build the generic 500. The filter's line says _a 500 was
answered for this request_; theirs says _why_. Two lines at the same level, correlated by the URL —
deleting the hand-written one to avoid the duplicate would delete the only record of the cause.

**Once the headers are sent, nothing is written.** The filter ended with an unconditional
`response.status(status).json(body)`, which on a flushed response throws from inside a filter, where
a throw has nowhere left to go. It now logs one `error` line — the method, the URL, the status the
client was _already_ given, and that the body is truncated, with the exception's stack — and calls
`response.destroy()`.

`destroy()` and not `end()`, because `end()` on a **chunked** response writes the terminating
zero-length chunk, which is the wire's way of saying _that was all of it_: a truncated audio file
reported to the learner's player as a complete one, which is worse than the failure being handled. On
a response with a declared `Content-Length` the client can at least count the shortfall, but Node
does not enforce that by default and the connection would return to the keep-alive pool having sent a
body its own header contradicts. The reasoning differs by transfer encoding and the answer does not,
so the filter must not branch on it — it cannot reliably tell what has already gone out.
`h5p.responses.ts` answers the same moment the same way, and the e2e that pins that behaviour asserts
the client sees an aborted connection. The level is `error` even when the exception is a 4xx: the
fact recorded is not the exception's status but that a response reported as succeeding is a lie. The
one truncation that is _not_ this server's fault is a client that navigates away mid-download, and it
stays out of this line only because both write paths swallow it on purpose — `h5p-public.controller.ts`'s
`sendFile` callback resolves rather than rejects once `res.headersSent`, and `h5p.responses.ts`'s
reporter returns early once the response is closed. A streaming route that lets an abandoned transfer
reject instead will earn an `error` line per abandoned seek; keeping that habit is what this rule
costs its callers.

The guard runs **first** and returns, before any classification, so a 5xx raised after the first byte
produces exactly one line — the truncation one, which strictly dominates "the answer was a 500" when
no 500 was ever sent.

_Cost:_ `destroy()` kills that TCP connection, so a pipelined request behind the broken one dies with
it. Accepted; identical to the sibling path that has already shipped. The guard also keys on
`headersSent` rather than on whether the response is still open, so a failure arriving after a
response had already **completed** normally would sever a healthy socket. No `@Res()` route throws
after `end()` today, and the behaviour this replaced — the write throwing out of the filter, leaving
the client to time out — is worse in every case, but a route that grows a post-`end()` `finally`
should be read against this paragraph. A half-installed dev machine now writes an `error` line per
request for its missing client tree, which is the point. Two `error` lines for one failure is the
ceiling, not three: `h5p.service.ts`'s rollback line and the hand-written cause lines fire on
disjoint failures — a failed index write is not an `H5pError`, so it reaches the filter through the
unrecognised-error branch rather than through the sanitizer — so a save that fails leaves the
rollback line and the filter's, and an H5P fault leaves the cause line and the filter's.

_Rejected:_ a `try`/`catch` around the write, which converts the symptom into a swallowed error and
still leaves the socket in whatever state the partial write put it. _Rejected:_ branching on the
transfer encoding. _Rejected:_ classifying first and guarding only the write, which logs the status
the filter _would_ have chosen — worth nothing, since nothing is sent — and produces two lines for
one failure. The status-only 4xx predicate is rejected in ADR-015.

_No e2e covers either._ Both write paths that flush headers check `res.headersSent` themselves, so
reaching the filter's guard through HTTP would need a fault injected between the flush and the throw
— a hook existing only to make the test possible. And the 5xx logging changes nothing an HTTP client
can see; asserting it through supertest means spying on `Logger.prototype` inside the running app,
which passes just as well against an implementation logging from the wrong place. The honest e2e
evidence is that the suite passes unchanged.

**Keep the guard anyway.** Unreachable is a fact about the five `@Res()` routes that exist today, not
about the filter: four in `h5p-public.controller.ts` and one — `GET /api/h5p/temp-files/*path` —
added later, by a different issue, to a different controller. What saves them is a `res.headersSent`
check no route declaration mentions: the three streaming routes — content files, library files and
temp files — reach it in a third file, `h5p.responses.ts`, while the two asset routes, `core/*path`
and `editor-assets/*path`, hit it inline in the private `sendAsset` helper their one-line bodies
delegate to, in the controller's own file. Two checks, two mechanisms, neither visible at the route,
so route six inherits the hazard without inheriting the check. Deleting the guard as dead code
removes the only place the invariant does not have to be re-derived per route, and what it prevents
shows up as a client that hangs rather than as a stack trace pointing back here.

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
