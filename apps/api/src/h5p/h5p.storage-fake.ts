import { Readable } from 'node:stream';
import type { StorageService, StoredObject } from '../infra/storage/storage.service.js';

/**
 * The part of `StorageService` the H5P adapters and service use. Naming it
 * makes the fake below check against the real signatures: change `list`'s
 * shape, or add an argument to `put`, and the fake stops compiling instead of
 * quietly answering an older contract.
 */
type StorageSurface = Pick<
  StorageService,
  | 'put'
  | 'delete'
  | 'exists'
  | 'stat'
  | 'list'
  | 'listSubdirectories'
  | 'deleteByPrefix'
  | 'createReadStream'
>;

/**
 * An in-memory stand-in for `StorageService`, used by the H5P adapter specs.
 *
 * It is a real implementation of the eight methods the adapters call —
 * including `deleteByPrefix`'s trailing-slash rule — so a path assertion in a
 * spec is exact rather than a claim about what a mock was asked to do. It lives
 * in `src` rather than beside one spec because both adapter specs and the
 * service spec need the same object graph.
 */
export class InMemoryStorage implements StorageSurface {
  readonly objects = new Map<string, { body: Buffer; createdAt: Date }>();

  constructor(private clock = new Date('2026-05-01T00:00:00.000Z')) {}

  put(path: string, body: Buffer | NodeJS.ReadableStream): Promise<void> {
    if (Buffer.isBuffer(body)) {
      this.objects.set(path, { body, createdAt: this.clock });
      return Promise.resolve();
    }

    return new Promise((resolvePut, reject) => {
      const chunks: Buffer[] = [];
      body.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
      body.on('error', reject);
      body.on('end', () => {
        this.objects.set(path, { body: Buffer.concat(chunks), createdAt: this.clock });
        resolvePut();
      });
    });
  }

  delete(path: string): Promise<void> {
    this.objects.delete(path);
    return Promise.resolve();
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(path));
  }

  stat(path: string): Promise<{ sizeBytes: number; createdAt: Date } | null> {
    const found = this.objects.get(path);
    return Promise.resolve(
      found ? { sizeBytes: found.body.length, createdAt: found.createdAt } : null,
    );
  }

  list(prefix: string): Promise<StoredObject[]> {
    return Promise.resolve(
      [...this.objects.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, object]) => ({
          path,
          sizeBytes: object.body.length,
          createdAt: object.createdAt,
        })),
    );
  }

  listSubdirectories(prefix: string): Promise<string[]> {
    const directories = new Set<string>();
    for (const path of this.objects.keys()) {
      if (!path.startsWith(prefix)) {
        continue;
      }
      const [head, ...rest] = path.slice(prefix.length).split('/');
      if (rest.length > 0 && head) {
        directories.add(head);
      }
    }
    return Promise.resolve([...directories]);
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    if (!prefix.endsWith('/')) {
      throw new Error(`A delete prefix must end in "/", got "${prefix}".`);
    }
    for (const path of [...this.objects.keys()]) {
      if (path.startsWith(prefix)) {
        this.objects.delete(path);
      }
    }
  }

  createReadStream(path: string, range?: { start?: number; end?: number }): Readable {
    const found = this.objects.get(path);
    if (!found) {
      throw new Error(`no such object: ${path}`);
    }
    const body = range
      ? found.body.subarray(range.start ?? 0, range.end === undefined ? undefined : range.end + 1)
      : found.body;

    return Readable.from([body]);
  }

  /** Contents of an object as text, for asserting what an adapter wrote. */
  text(path: string): string {
    const found = this.objects.get(path);
    if (!found) {
      throw new Error(`no such object: ${path}`);
    }
    return found.body.toString('utf-8');
  }

  paths(): string[] {
    return [...this.objects.keys()].sort();
  }

  /**
   * The cast is unavoidable — `StorageService` is a class with private state
   * this does not model — but it is not unchecked: `implements StorageSurface`
   * above is what makes a drift in any method the adapters call a compile
   * error rather than a spec that keeps passing against a contract that has
   * moved.
   */
  asStorageService(): StorageService {
    return this as unknown as StorageService;
  }
}
