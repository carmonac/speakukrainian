/**
 * `yauzl-promise` ships no type declarations and DefinitelyTyped has no package
 * for v4, so the members `fetch-h5p-core.ts` uses are declared here.
 *
 * A near-duplicate of `apps/api/src/types/yauzl-promise.d.ts` on purpose: an
 * ambient module declaration belongs to one TypeScript project, and these two
 * packages compile separately. Only the members each side uses are declared, so
 * an unlisted export is a compile error rather than a silent `any`.
 */
declare module 'yauzl-promise' {
  export interface ZipEntry {
    /** The decoded entry name. A directory entry ends in `/`. */
    readonly filename: string;
    /**
     * The entry's data, decompressed and checked against the checksum the
     * archive declares for it. The stream fails when either does not hold.
     */
    openReadStream(): Promise<import('node:stream').Readable>;
  }

  interface ZipReader extends AsyncIterable<ZipEntry> {
    close(): Promise<void>;
  }

  interface OpenOptions {
    /**
     * Yauzl's own traversal check, turned off deliberately: the extractor needs
     * the raw entry name to apply a stricter rule of its own, and a throw from
     * inside the reader would name no rule anyone here owns.
     */
    validateFilenames?: boolean;
  }

  export function open(path: string, options?: OpenOptions): Promise<ZipReader>;
}
