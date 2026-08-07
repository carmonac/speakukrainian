import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP writer for tests, which exists because every real one refuses
 * to write the names the guards have to be proved against.
 *
 * `yazl` — the fixture builder's writer, and the library's own — validates
 * entry names and will not emit `..`, an absolute path or a backslash. That is
 * correct of it and useless here: without an archive that carries such a name,
 * nothing can show what the API answers for one, and a unit test on a path
 * function proves only that the function works, not that it is in the path.
 *
 * Stored (uncompressed) entries only, no data descriptors and no Zip64, which
 * is all a 2 KB fixture needs. It lives in `src` for the same reason
 * `h5p.storage-fake.ts` does: a spec under `src` cannot import from `test/`
 * (that directory is outside the build's `rootDir`), and both the scan's unit
 * spec and the e2e fixtures need this writer.
 */
export interface RawZipEntry {
  /** Written verbatim, including any name a real writer would reject. */
  name: string;
  content: Buffer | string;
  /**
   * An Info-ZIP Unicode Path extra field (0x7075) carrying a second name.
   * Yauzl prefers it over the one in the header, so this is how an archive can
   * unpack to somewhere other than the name a plain reader would report.
   */
  unicodeName?: string;
  /**
   * Written into both headers. `8` deflates the data for real, since that is
   * the method every archiver writes and the only one a reader will decode;
   * any other value is written verbatim over stored data, because the rule
   * those exist for reads the method out of the central directory and refuses
   * the entry before anything opens it — and Node can write neither
   * Deflate64 (9), BZip2 (12) nor LZMA (14) anyway.
   */
  compressionMethod?: number;
  /**
   * Sets the traditional-encryption flag and prepends the 12-byte header such
   * an entry carries, which is what the reader checks a stored entry's sizes
   * against.
   */
  encrypted?: boolean;
  /**
   * Flips a byte of the data *after* its checksum is written — a corrupt byte
   * on disk, as the reader sees it.
   */
  corruptData?: boolean;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;

/** Names are written UTF-8, so the general purpose flag says so (bit 11). */
const UTF8_NAMES = 0x0800;
/** Traditional PKWARE encryption (bit 0). */
const ENCRYPTED = 0x0001;
/** The header traditional encryption prefixes the data with. */
const ENCRYPTION_HEADER_SIZE = 12;
const VERSION = 20;
const STORED = 0;
const DEFLATE = 8;

/** A fixed, valid DOS timestamp: 2026-01-01 00:00:00. */
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

export function buildRawZip(entries: RawZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf-8');
    const body = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content, 'utf-8');
    const checksum = crc32(body);
    const method = entry.compressionMethod ?? STORED;
    const data = entryData(body, method, entry);
    const flag = UTF8_NAMES | (entry.encrypted ? ENCRYPTED : 0);

    const local = Buffer.alloc(LOCAL_HEADER_SIZE);
    local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(flag, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const extra = unicodePathField(name, entry.unicodeName);

    const header = Buffer.alloc(CENTRAL_HEADER_SIZE);
    header.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(VERSION, 6);
    header.writeUInt16LE(flag, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(body.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);

    parts.push(local, name, data);
    central.push(header, name, extra);
    offset += local.length + name.length + data.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(END_OF_CENTRAL_DIRECTORY_SIZE);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, directory, end]);
}

/** What actually goes on the wire for an entry, once it has been damaged. */
function entryData(body: Buffer, method: number, entry: RawZipEntry): Buffer {
  let data = method === DEFLATE ? deflateRawSync(body) : body;

  if (entry.corruptData && data.length > 0) {
    data = Buffer.from(data);
    data.writeUInt8(data.readUInt8(0) ^ 0xff, 0);
  }
  if (entry.encrypted) {
    data = Buffer.concat([Buffer.alloc(ENCRYPTION_HEADER_SIZE), data]);
  }

  return data;
}

/**
 * Version 1 of the extra field, whose checksum of the header name is what a
 * reader uses to decide the two names still belong together.
 */
function unicodePathField(headerName: Buffer, unicodeName: string | undefined): Buffer {
  if (unicodeName === undefined) {
    return Buffer.alloc(0);
  }

  const encoded = Buffer.from(unicodeName, 'utf-8');
  const data = Buffer.alloc(5 + encoded.length);
  data.writeUInt8(1, 0);
  data.writeUInt32LE(crc32(headerName), 1);
  encoded.copy(data, 5);

  const field = Buffer.alloc(4 + data.length);
  field.writeUInt16LE(0x7075, 0);
  field.writeUInt16LE(data.length, 2);
  data.copy(field, 4);

  return field;
}
