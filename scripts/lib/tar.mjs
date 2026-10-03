// A minimal tar reader: enough for the ustar + pax archives `git archive` produces, so the
// release scripts can hash every shipped file without extracting to disk or shelling out.

import { createHash } from 'node:crypto';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const str = (buf, start, len) => {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul < 0 ? len : nul).toString('utf8');
};

/**
 * @param {Buffer} tar uncompressed tar bytes
 * @returns {{path: string, mode: number, data: Buffer}[]} regular files in archive order
 */
export function readTar(tar) {
  const files = [];
  let pos = 0;
  let paxPath = null;
  while (pos + 512 <= tar.length) {
    const header = tar.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(str(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(header, 345, 155);
    const name = str(header, 0, 100);
    const dataStart = pos + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    pos = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      // pax extended header: "<len> key=value\n" records applying to the next entry.
      for (const rec of data.toString('utf8').split('\n')) {
        const m = /^\d+ path=(.*)$/.exec(rec);
        if (m) paxPath = m[1];
      }
    } else if (type === 'g') {
      // Global pax header (the commit id lives here); nothing to apply.
    } else if (type === '0') {
      files.push({ path: paxPath ?? (prefix ? `${prefix}/${name}` : name), mode: parseInt(str(header, 100, 8).trim() || '0', 8), data });
      paxPath = null;
    } else {
      paxPath = null; // directories, symlinks: not hashed as content
    }
  }
  return files;
}
