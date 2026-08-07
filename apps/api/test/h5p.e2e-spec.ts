import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import type { Auth } from 'firebase-admin/auth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COLLECTIONS,
  MAX_H5P_UPLOAD_BYTES,
  h5pContentSchema,
  h5pSaveResultSchema,
  h5pUploadTooLargeMessage,
  notAnH5pPackageMessage,
  type H5pSaveResult,
} from '@speakukrainian/shared';
import { FIRESTORE } from '../src/infra/firestore/firestore.tokens.js';
import { StorageService } from '../src/infra/storage/storage.service.js';
import { authOf, createTestApp, signInAs, type TestUser } from './emulator.js';
import {
  CONTENT_FILE,
  DEP_LIBRARY_DIR,
  MAIN_LIBRARY_DIR,
  buildH5pPackage,
  buildH5pPackageWithEntry,
  buildRawH5pPackage,
} from './fixtures/h5p-package.js';

const LIBRARIES_PREFIX = 'h5p/libraries/';
const CONTENT_PREFIX = 'h5p/content/';
const MAIN_LIBRARY_PREFIX = `${LIBRARIES_PREFIX}${MAIN_LIBRARY_DIR}/`;
const DEP_LIBRARY_PREFIX = `${LIBRARIES_PREFIX}${DEP_LIBRARY_DIR}/`;

interface ErrorBody {
  statusCode: number;
  message: string;
  errors?: string[];
}

/** Unique per run, so a leftover from an earlier one cannot pass for a hit. */
const ESCAPE_MARKER = `pwned-${randomUUID()}.txt`;

/**
 * Entry names that must never reach `path.join(tempDirectory, name)`.
 *
 * The importer extracts into a `tmp.dir()` under `os.tmpdir()`, so `../<name>`
 * lands in `os.tmpdir()` itself and the six-deep one bottoms out at `/tmp`.
 * Those two are the escape targets this suite watches; the rest cannot leave
 * the temp directory but must still be refused by name rather than answered
 * with a 500 raised from inside the library.
 */
const HOSTILE_ENTRY_NAMES = [
  `content/../../../../../../tmp/${ESCAPE_MARKER}`,
  `../${ESCAPE_MARKER}`,
  `content/a/../../${ESCAPE_MARKER}`,
  `/etc/${ESCAPE_MARKER}`,
  `C:\\${ESCAPE_MARKER}`,
  `content\\..\\..\\${ESCAPE_MARKER}`,
  'content/..',
  `content/./x/../../${ESCAPE_MARKER}`,
];

/** Where the two escaping shapes above would land if nothing stopped them. */
const ESCAPE_TARGETS = [join(tmpdir(), ESCAPE_MARKER), join('/tmp', ESCAPE_MARKER)];

/**
 * Packages that are malformed rather than hostile: nothing escapes, and the
 * caller still has to be told which rule their file broke instead of being
 * shown a server fault they cannot act on.
 */
const MALFORMED_PACKAGES: [shape: string, entry: string, message: string][] = [
  [
    'carrying a zero-length entry name',
    '',
    'The file is not a readable ZIP archive, so it is not an H5P package.',
  ],
  [
    'whose path has a segment past the filesystem limit',
    `${'a'.repeat(256)}/x.txt`,
    'The package contains a file whose name is too long to unpack.',
  ],
  [
    'with a top-level folder that is not a library',
    'notes/scratch.txt',
    'Every folder in the package other than "content" must be a library folder containing a library.json.',
  ],
];

describe('h5p (e2e)', () => {
  let app: INestApplication;
  let auth: Auth;
  let storage: StorageService;
  let firestore: Firestore;
  let editor: TestUser;
  let student: TestUser;

  /** Every content id this suite created, removed in teardown. */
  const createdContentIds: string[] = [];

  const server = (): ReturnType<INestApplication['getHttpServer']> => app.getHttpServer();

  const countObjects = async (prefix: string): Promise<number> =>
    (await storage.list(prefix)).length;

  /**
   * Every object in the bucket, not only the ones under `h5p/`: a containment
   * test that only looks where the files are supposed to go cannot see a file
   * that went somewhere else.
   */
  const bucketPaths = async (): Promise<string[]> =>
    (await storage.list('')).map((object) => object.path).sort();

  const post = (token: string, body: Buffer, filename: string) =>
    request(server())
      .post('/api/h5p/content')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', body, { filename, contentType: 'application/octet-stream' });

  const upload = async (body: Buffer, filename = 'drill.h5p'): Promise<H5pSaveResult> => {
    const response = await post(editor.idToken, body, filename).expect(201);
    const saved = h5pSaveResultSchema.parse(response.body);
    createdContentIds.push(saved.contentId);
    return saved;
  };

  /** The patch version the installed `library.json` reports. */
  const installedPatchVersion = async (prefix: string): Promise<number> => {
    const url = storage.publicUrl(`${prefix}library.json`);
    const served = await fetch(url);
    expect(served.status).toBe(200);
    return ((await served.json()) as { patchVersion: number }).patchVersion;
  };

  /**
   * Libraries persist across runs by design, and the patch/downgrade cases read
   * the installed version — so a previous run's patch 2 would make this run's
   * patch 1 install look like a downgrade and the test would pass for the wrong
   * reason. Starting from no `SpeakTest.*` libraries is what keeps the run
   * repeatable.
   */
  const removeFixtureLibraries = async (): Promise<void> => {
    await storage.deleteByPrefix(MAIN_LIBRARY_PREFIX);
    await storage.deleteByPrefix(DEP_LIBRARY_PREFIX);
  };

  beforeAll(async () => {
    app = await createTestApp();
    auth = authOf(app);
    storage = app.get(StorageService);
    firestore = app.get<Firestore>(FIRESTORE);
    [editor, student] = await Promise.all([signInAs(auth, 'editor'), signInAs(auth, 'student')]);
    await removeFixtureLibraries();
  });

  afterAll(async () => {
    if (storage) {
      await Promise.all(
        createdContentIds.map((id) => storage.deleteByPrefix(`${CONTENT_PREFIX}${id}/`)),
      );
      await removeFixtureLibraries();
    }
    if (firestore) {
      await Promise.all(
        createdContentIds.map((id) =>
          firestore.collection(COLLECTIONS.h5pContent).doc(id).delete(),
        ),
      );
    }
    const created = [editor, student].filter((user) => user !== undefined);
    await Promise.all(created.map((user) => auth.deleteUser(user.uid)));
    if (app) {
      await app.close();
    }
  });

  it('installs a package: content files land under h5p/content/<id>/', async () => {
    const saved = await upload(await buildH5pPackage({ title: 'Kyiv listening drill' }));

    expect(saved.title).toBe('Kyiv listening drill');
    // The whitespace ubername `h5pContentSchema` documents, not the directory form.
    expect(saved.mainLibrary).toBe('SpeakTest.Main 1.0');

    const prefix = `${CONTENT_PREFIX}${saved.contentId}/`;
    await expect(storage.exists(`${prefix}h5p.json`)).resolves.toBe(true);
    await expect(storage.exists(`${prefix}content.json`)).resolves.toBe(true);
    // Stripped of its `content/` prefix, exactly as `FileContentStorage` does.
    await expect(storage.exists(`${prefix}${CONTENT_FILE}`)).resolves.toBe(true);
    await expect(storage.exists(`${prefix}content/${CONTENT_FILE}`)).resolves.toBe(false);
  });

  it('installs the package libraries and writes the index document', async () => {
    const saved = await upload(await buildH5pPackage());

    await expect(storage.exists(`${MAIN_LIBRARY_PREFIX}library.json`)).resolves.toBe(true);
    await expect(storage.exists(`${MAIN_LIBRARY_PREFIX}main.js`)).resolves.toBe(true);
    await expect(storage.exists(`${DEP_LIBRARY_PREFIX}library.json`)).resolves.toBe(true);

    const document = await firestore.collection(COLLECTIONS.h5pContent).doc(saved.contentId).get();
    expect(document.exists).toBe(true);

    const content = h5pContentSchema.parse({
      id: document.id,
      ...(document.data() as object),
      audit: {
        createdAt: new Date().toISOString(),
        createdBy: editor.uid,
        updatedAt: new Date().toISOString(),
        updatedBy: editor.uid,
      },
    });
    expect(content.storagePath).toBe(`${CONTENT_PREFIX}${saved.contentId}`);
    expect(content.mainLibrary).toBe('SpeakTest.Main 1.0');
    // Zero would mean the size was never read off the listing.
    expect(content.sizeBytes).toBeGreaterThan(0);
    expect(content.pageId).toBeNull();
  });

  it('installs shared libraries once when the same package is uploaded twice', async () => {
    const packageBytes = await buildH5pPackage();
    const first = await upload(packageBytes);
    const before = await countObjects(LIBRARIES_PREFIX);

    const second = await upload(packageBytes);

    expect(second.contentId).not.toBe(first.contentId);
    await expect(storage.exists(`${CONTENT_PREFIX}${first.contentId}/h5p.json`)).resolves.toBe(
      true,
    );
    await expect(storage.exists(`${CONTENT_PREFIX}${second.contentId}/h5p.json`)).resolves.toBe(
      true,
    );
    // A broken `isInstalled` would reinstall both libraries; the count is what
    // catches it, since a reinstall overwrites the same object names.
    await expect(countObjects(LIBRARIES_PREFIX)).resolves.toBe(before);
  });

  it('applies a newer patch version and refuses to downgrade back', async () => {
    await expect(installedPatchVersion(MAIN_LIBRARY_PREFIX)).resolves.toBe(1);

    await upload(await buildH5pPackage({ patchVersion: 2 }));

    // Still one directory per major.minor: a patch updates in place.
    await expect(
      storage.listSubdirectories(LIBRARIES_PREFIX).then((names) => names.sort()),
    ).resolves.toEqual([DEP_LIBRARY_DIR, MAIN_LIBRARY_DIR]);
    await expect(installedPatchVersion(MAIN_LIBRARY_PREFIX)).resolves.toBe(2);
    await expect(installedPatchVersion(DEP_LIBRARY_PREFIX)).resolves.toBe(2);

    await upload(await buildH5pPackage({ patchVersion: 1 }));

    // `getLibrary` losing `patchVersion` would make this 1.
    await expect(installedPatchVersion(MAIN_LIBRARY_PREFIX)).resolves.toBe(2);
  });

  it('answers 400 for a file that is not a readable archive', async () => {
    const before = await countObjects(CONTENT_PREFIX);

    const response = await post(
      editor.idToken,
      Buffer.from('not a zip at all'),
      'broken.h5p',
    ).expect(400);

    const body = response.body as ErrorBody;
    expect(body.statusCode).toBe(400);
    // Not a 500 escaping from inside the library.
    expect(body.message).toBe(
      'The file is not a readable ZIP archive, so it is not an H5P package.',
    );
    await expect(countObjects(CONTENT_PREFIX)).resolves.toBe(before);
  });

  it('answers 400 naming the rule when the package has no h5p.json', async () => {
    const before = await countObjects(CONTENT_PREFIX);

    const response = await post(
      editor.idToken,
      await buildH5pPackage({ omitH5pJson: true }),
      'no-metadata.h5p',
    ).expect(400);

    const body = response.body as ErrorBody;
    expect(body.message).toBe('The package is not a valid H5P package.');
    // Without the aggregate's sub-errors the admin is told only that
    // validation failed, with nothing to act on.
    expect(body.errors).toContain('invalid-h5p-json-file');
    await expect(countObjects(CONTENT_PREFIX)).resolves.toBe(before);
  });

  it('installs a package written by the raw ZIP writer, so the writer is not the variable', async () => {
    // The control for the hostile cases below: same bytes on every entry, same
    // writer, one name different. Without this a 400 there could just as well
    // mean the fixture is unreadable.
    const saved = await upload(buildRawH5pPackage({ title: 'Raw writer control' }));

    expect(saved.title).toBe('Raw writer control');
    await expect(
      storage.exists(`${CONTENT_PREFIX}${saved.contentId}/${CONTENT_FILE}`),
    ).resolves.toBe(true);
  });

  it.each(HOSTILE_ENTRY_NAMES)(
    'refuses the entry %j with a 400 and writes nothing anywhere',
    async (name) => {
      const before = await bucketPaths();

      const response = await post(
        editor.idToken,
        buildH5pPackageWithEntry(name, 'this must never be written'),
        'hostile.h5p',
      ).expect(400);

      const body = response.body as ErrorBody;
      // Naming the problem, not "Internal server error" with a stack in the log.
      expect(body.message).toBe('The package contains a file with an unusable path.');

      // Nothing landed in the bucket at all — not under a content prefix, not
      // under `h5p/libraries/`, not anywhere else.
      await expect(bucketPaths()).resolves.toEqual(before);
      for (const target of ESCAPE_TARGETS) {
        await expect(access(target)).rejects.toThrow();
      }
    },
  );

  it.each(MALFORMED_PACKAGES)(
    'answers 400 naming the problem for a package %s',
    async (_shape, entry, message) => {
      // Each of these used to escape as `500 Internal server error` with an
      // `Unhandled POST` stack in the log: the library raises a plain `Error`
      // for them — from `Buffer.allocUnsafe`, from `mkdir`, from an assertion
      // inside `PackageValidator` — and a plain `Error` is a server fault
      // everywhere else, correctly.
      const before = await countObjects(CONTENT_PREFIX);

      const response = await post(
        editor.idToken,
        buildH5pPackageWithEntry(entry, 'x'),
        'malformed.h5p',
      ).expect(400);

      expect((response.body as ErrorBody).message).toBe(message);
      await expect(countObjects(CONTENT_PREFIX)).resolves.toBe(before);
    },
  );

  it('answers 415 for a file that is not named .h5p', async () => {
    const response = await post(editor.idToken, await buildH5pPackage(), 'drill.zip').expect(415);

    // The content type is identical to the accepted uploads above, so this can
    // only be the extension check.
    expect((response.body as ErrorBody).message).toBe(notAnH5pPackageMessage('drill.zip'));
  });

  it('answers 413 naming the limit for an oversize package and writes nothing', async () => {
    const before = await countObjects(CONTENT_PREFIX);

    const response = await post(
      editor.idToken,
      Buffer.alloc(MAX_H5P_UPLOAD_BYTES + 1),
      'huge.h5p',
    ).expect(413);

    const body = response.body as ErrorBody;
    expect(body.statusCode).toBe(413);
    // Not multer's bare `File too large`, which never names 100 MB.
    expect(body.message).toBe(h5pUploadTooLargeMessage());
    await expect(countObjects(CONTENT_PREFIX)).resolves.toBe(before);
  });

  it('refuses an upload from a student', async () => {
    await post(student.idToken, await buildH5pPackage(), 'drill.h5p').expect(403);
  });

  it('refuses an upload without a token', async () => {
    await request(server())
      .post('/api/h5p/content')
      .attach('file', await buildH5pPackage(), {
        filename: 'drill.h5p',
        contentType: 'application/octet-stream',
      })
      .expect(401);
  });
});
