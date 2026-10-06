// A reader for the subset of the SCIP protobuf schema Unknot uses (field numbers from
// https://github.com/sourcegraph/scip/blob/main/scip.proto):
//   Index              metadata=1 documents=2 external_symbols=3
//   Metadata           tool_info=2 project_root=3        ToolInfo  name=1 version=2
//   Document           relative_path=1 occurrences=2 symbols=3 language=4
//   Occurrence         range=1 (packed int32) symbol=2 symbol_roles=3 enclosing_range=7 (packed int32)
//   SymbolInformation  symbol=1 relationships=4 kind=5 display_name=6 enclosing_symbol=8
//   Relationship       symbol=1 is_reference=2 is_implementation=3 is_type_definition=4 is_definition=5
// Every other field is skipped by wire type (varint, 64-bit, length-delimited, 32-bit), so a
// newer indexer's additions do not matter. No dependencies.
//
// An index can be hundreds of MB. `scipRecords` reads the file through one fixed window and
// yields one document at a time, so memory is bounded by the largest document, not the file.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export const ROLE = Object.freeze({ Definition: 1, Import: 2, WriteAccess: 4, ReadAccess: 8, Generated: 16, Test: 32, ForwardDefinition: 64 });

const WINDOW = 1 << 20;

// --- message decoding (from a buffer slice) -----------------------------------------------------

let P = 0; // read position of the decoder below (single-threaded, reset per message)

function varint(b) {
  let r = 0;
  let shift = 0;
  let x;
  do {
    x = b[P++];
    if (x === undefined) throw new RangeError('truncated SCIP message (varint)');
    if (shift < 56) r += (x & 0x7f) * 2 ** shift;
    shift += 7;
  } while (x & 0x80);
  return r;
}

function skipField(b, wire, end) {
  if (wire === 0) varint(b);
  else if (wire === 1) P += 8;
  else if (wire === 2) {
    const n = varint(b); // not `P += varint(b)`: that reads P before the varint advances it
    P += n;
  }
  else if (wire === 5) P += 4;
  else throw new RangeError(`unsupported protobuf wire type ${wire}`);
  if (P > end) throw new RangeError('truncated SCIP message (field)');
}

function lenDelimited(b, end) {
  const len = varint(b);
  const stop = P + len;
  if (stop > end) throw new RangeError('truncated SCIP message (length)');
  return stop;
}

function str(b, end) {
  const stop = lenDelimited(b, end);
  const s = b.toString('utf8', P, stop);
  P = stop;
  return s;
}

/** A repeated int32 that may arrive packed (wire type 2) or one value per tag (wire type 0). */
function ints(b, wire, end, into) {
  if (wire === 2) {
    const stop = lenDelimited(b, end);
    while (P < stop) into.push(varint(b) | 0);
  } else into.push(varint(b) | 0);
}

/** @returns {{range: number[], symbol: string, roles: number, enclosing: number[]|null}} */
function occurrence(b, start, end) {
  P = start;
  const o = { range: [], symbol: '', roles: 0, enclosing: null };
  while (P < end) {
    const tag = varint(b);
    const f = Math.floor(tag / 8);
    const w = tag & 7;
    if (f === 1 && (w === 2 || w === 0)) ints(b, w, end, o.range);
    else if (f === 2 && w === 2) o.symbol = str(b, end);
    else if (f === 3 && w === 0) o.roles = varint(b) | 0;
    else if (f === 7 && (w === 2 || w === 0)) ints(b, w, end, (o.enclosing ??= []));
    else skipField(b, w, end);
  }
  return o;
}

const REL_FLAGS = { 2: 'is_reference', 3: 'is_implementation', 4: 'is_type_definition', 5: 'is_definition' };

function relationship(b, start, end) {
  P = start;
  const r = { symbol: '', is_reference: false, is_implementation: false, is_type_definition: false, is_definition: false };
  while (P < end) {
    const tag = varint(b);
    const f = Math.floor(tag / 8);
    const w = tag & 7;
    if (f === 1 && w === 2) r.symbol = str(b, end);
    else if (REL_FLAGS[f] && w === 0) r[REL_FLAGS[f]] = varint(b) !== 0;
    else skipField(b, w, end);
  }
  return r;
}

/** @returns {{symbol: string, relationships: object[], kind: number, display_name: string, enclosing_symbol: string}} */
export function decodeSymbolInformation(b, start = 0, end = b.length) {
  P = start;
  const s = { symbol: '', relationships: [], kind: 0, display_name: '', enclosing_symbol: '' };
  while (P < end) {
    const tag = varint(b);
    const f = Math.floor(tag / 8);
    const w = tag & 7;
    if (f === 1 && w === 2) s.symbol = str(b, end);
    else if (f === 6 && w === 2) s.display_name = str(b, end);
    else if (f === 8 && w === 2) s.enclosing_symbol = str(b, end);
    else if (f === 4 && w === 2) {
      const stop = lenDelimited(b, end);
      const rel = relationship(b, P, stop);
      s.relationships.push(rel);
      P = stop;
    } else if (f === 5 && w === 0) s.kind = varint(b) | 0;
    else skipField(b, w, end);
  }
  return s;
}

/**
 * @param {{pathsOnly?: boolean}} [opts] `pathsOnly` skips occurrences and symbols
 * @returns {{relative_path: string, language: string, occurrences: object[], symbols: object[]}}
 */
export function decodeDocument(b, start = 0, end = b.length, { pathsOnly = false } = {}) {
  P = start;
  const d = { relative_path: '', language: '', occurrences: [], symbols: [] };
  while (P < end) {
    const tag = varint(b);
    const f = Math.floor(tag / 8);
    const w = tag & 7;
    if (f === 1 && w === 2) d.relative_path = str(b, end);
    else if (f === 4 && w === 2) d.language = str(b, end);
    else if ((f === 2 || f === 3) && w === 2 && !pathsOnly) {
      const stop = lenDelimited(b, end);
      const at = P;
      if (f === 2) d.occurrences.push(occurrence(b, at, stop));
      else d.symbols.push(decodeSymbolInformation(b, at, stop));
      P = stop;
    } else skipField(b, w, end);
  }
  return d;
}

function decodeMetadata(b, start, end) {
  P = start;
  const m = { project_root: '', tool: { name: '', version: '' } };
  while (P < end) {
    const tag = varint(b);
    const f = Math.floor(tag / 8);
    const w = tag & 7;
    if (f === 3 && w === 2) m.project_root = str(b, end);
    else if (f === 2 && w === 2) {
      const stop = lenDelimited(b, end);
      while (P < stop) {
        const t = varint(b);
        const g = Math.floor(t / 8);
        const x = t & 7;
        if ((g === 1 || g === 2) && x === 2) m.tool[g === 1 ? 'name' : 'version'] = str(b, stop);
        else skipField(b, x, stop);
      }
    } else skipField(b, w, end);
  }
  return m;
}

/** An occurrence range as `[startLine, startChar, endLine, endChar]` (0-based). */
export function rangeOf(r) {
  return r.length >= 4 ? [r[0], r[1], r[2], r[3]] : [r[0] ?? 0, r[1] ?? 0, r[0] ?? 0, r[2] ?? 0];
}

// --- streaming ----------------------------------------------------------------------------------

class Window {
  constructor(fd, size) {
    this.fd = fd;
    this.size = size;
    this.buf = Buffer.allocUnsafe(WINDOW);
    this.i = 0; // next unread byte in buf
    this.n = 0; // bytes held in buf
    this.pos = 0; // file offset of the end of the held bytes
  }

  /** Bytes of the file not yet consumed. */
  get left() {
    return this.size - (this.pos - (this.n - this.i));
  }

  /** Make `k` bytes available (fewer only at the end of the file). */
  fill(k) {
    if (this.n - this.i >= k) return;
    if (k > this.buf.length) {
      const bigger = Buffer.allocUnsafe(k);
      this.buf.copy(bigger, 0, this.i, this.n);
      this.buf = bigger;
    } else this.buf.copy(this.buf, 0, this.i, this.n);
    this.n -= this.i;
    this.i = 0;
    while (this.n < k) {
      const got = readSync(this.fd, this.buf, this.n, this.buf.length - this.n, this.pos);
      if (!got) break;
      this.n += got;
      this.pos += got;
    }
  }

  /** The next `len` bytes, as a view that stays valid until the next call. */
  take(len) {
    if (len > this.left) throw new RangeError('truncated SCIP index (a message runs past the end of the file)');
    this.fill(len);
    const out = this.buf.subarray(this.i, this.i + len);
    this.i += len;
    return out;
  }

  skip(len) {
    if (len > this.left) throw new RangeError('truncated SCIP index (a field runs past the end of the file)');
    const have = this.n - this.i;
    if (len <= have) this.i += len;
    else {
      this.pos += len - have;
      this.i = 0;
      this.n = 0;
    }
  }

  /** The next varint, or null at the end of the file. */
  varint() {
    this.fill(10);
    if (this.i >= this.n) return null;
    P = this.i;
    const v = varint(this.buf);
    if (P > this.n) throw new RangeError('truncated SCIP index (varint)');
    this.i = P;
    return v;
  }
}

/**
 * Records of a SCIP index file, in file order, one at a time:
 * `{ type: 'metadata', value }`, `{ type: 'document', value }`, `{ type: 'external', value }`
 * (an external symbol's SymbolInformation). Throws RangeError on a malformed or truncated file.
 * With `pathsOnly` a document carries just its `relative_path` and `language` (fast).
 */
export function* scipRecords(path, { pathsOnly = false } = {}) {
  const fd = openSync(path, 'r');
  try {
    const w = new Window(fd, fstatSync(fd).size);
    for (;;) {
      const tag = w.varint();
      if (tag === null) return;
      const f = Math.floor(tag / 8);
      const wire = tag & 7;
      if (wire === 2) {
        const len = w.varint();
        if (len === null) throw new RangeError('truncated SCIP index (length)');
        if (f >= 1 && f <= 3 && !(pathsOnly && f === 3)) {
          const b = w.take(len);
          if (f === 1) yield { type: 'metadata', value: decodeMetadata(b, 0, len) };
          else if (f === 2) yield { type: 'document', value: decodeDocument(b, 0, len, { pathsOnly }) };
          else yield { type: 'external', value: decodeSymbolInformation(b, 0, len) };
        } else w.skip(len);
      } else if (wire === 0) w.varint();
      else if (wire === 1) w.skip(8);
      else if (wire === 5) w.skip(4);
      else throw new RangeError(`unsupported protobuf wire type ${wire} in a SCIP index`);
    }
  } finally {
    closeSync(fd);
  }
}
