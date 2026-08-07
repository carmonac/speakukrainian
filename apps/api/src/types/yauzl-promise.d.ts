/**
 * `yauzl-promise` ships no type declarations and DefinitelyTyped has no package
 * for v4, so the members `h5p.package-scan.ts` uses are declared here.
 *
 * Read off the installed v4 sources rather than recalled. A declaration that
 * does not match the runtime is a lie the compiler cannot catch, so the scan's
 * specs drive it against real archives — a wrong shape here fails a test, not
 * only a review.
 */
declare module 'yauzl-promise' {
  export interface ZipEntry {
    /** The decoded entry name. A directory entry ends in `/`. */
    readonly filename: string;
    /**
     * The ZIP compression method from the central directory. `0` is stored and
     * `8` is deflate; `openReadStream` asserts it is one of those two.
     */
    readonly compressionMethod: number;
    /** Whether the entry's data is encrypted, which the reader cannot decrypt. */
    isEncrypted(): boolean;
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
     * Yauzl's own traversal check, which the scan turns off deliberately: it
     * needs the raw entry name to apply a stricter rule of its own, and a throw
     * from inside the reader would name no rule anyone here owns.
     */
    validateFilenames?: boolean;
  }

  export function open(path: string, options?: OpenOptions): Promise<ZipReader>;
}
