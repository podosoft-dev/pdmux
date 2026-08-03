import { crc32 } from "node:zlib";

/**
 * A minimal ZIP writer, stored (uncompressed) only.
 *
 * WHY NOT A LIBRARY: the archive is four small text files. Every packaging
 * dependency is one more thing in the image, one more advisory to read and one
 * more thing that can want a native build — and the format's stored variant is a
 * header, the bytes, and a directory at the end. This is the whole of it.
 *
 * Stored rather than deflated on purpose: the saving on a few kilobytes of
 * markdown is irrelevant, and "the bytes are right there" makes the digest we
 * publish easy to reason about.
 *
 * ⚠ NOT A GENERAL-PURPOSE WRITER. No zip64, no unicode path extras, no
 * directories entries, no permissions. It handles ASCII paths under 64 KiB of
 * content each, which is what this package is. Anything else belongs in a real
 * library rather than in a widened version of this.
 */

export interface ZipEntry {
  /** Forward-slash path inside the archive. */
  path: string;
  data: Buffer;
}

/** DOS timestamp fields. Fixed, so the same inputs give the same bytes. */
const DOS_TIME = 0;
// 1 Jan 1980, the format's own epoch: (year-1980)<<9 | month<<5 | day.
// ⚠ Month and day are 1-based. A zero in either is not "unset", it is an
// invalid date, and some extractors refuse the entry rather than shrug.
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, entry.data);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); // central directory header
    directory.writeUInt16LE(20, 4); // version made by
    directory.writeUInt16LE(20, 6); // version needed
    directory.writeUInt16LE(0, 8);
    directory.writeUInt16LE(0, 10); // stored
    directory.writeUInt16LE(DOS_TIME, 12);
    directory.writeUInt16LE(DOS_DATE, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(entry.data.length, 20);
    directory.writeUInt32LE(entry.data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30); // extra
    directory.writeUInt16LE(0, 32); // comment
    directory.writeUInt16LE(0, 34); // disk
    directory.writeUInt16LE(0, 36); // internal attrs
    directory.writeUInt32LE(0, 38); // external attrs
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);

    offset += local.length + name.length + entry.data.length;
  }

  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // disk
  end.writeUInt16LE(0, 6); // disk with directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBytes, end]);
}
