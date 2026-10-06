// A tiny protobuf encoder for SCIP indexes, so tests can build the index an indexer would write
// without a .NET SDK or a compiler. Field numbers follow scip.proto (see the reader).

import { writeFileSync } from 'node:fs';

export const ROLE = { Definition: 1, Import: 2, WriteAccess: 4, ReadAccess: 8 };
export const KIND = { Class: 7, Interface: 21, Field: 15, Property: 41, Method: 26 };

export function varint(n) {
  const out = [];
  let v = BigInt.asUintN(64, BigInt(n));
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

const tag = (field, wire) => varint(field * 8 + wire);
export const vfield = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);
export const lfield = (field, buf) => {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  return Buffer.concat([tag(field, 2), varint(b.length), b]);
};
export const packed = (field, nums) => lfield(field, Buffer.concat(nums.map(varint)));

/** Fields no reader of this subset knows: one of each wire type (varint, 64-bit, length-delimited, 32-bit). */
export const unknownFields = (base = 90) => Buffer.concat([
  vfield(base, 12345),
  Buffer.concat([tag(base + 1, 1), Buffer.alloc(8, 7)]),
  lfield(base + 2, 'ignored text'),
  Buffer.concat([tag(base + 3, 5), Buffer.alloc(4, 9)]),
]);

/** `range` is `[line, start, end]` or `[startLine, startChar, endLine, endChar]`. */
export function occurrence({ range, symbol, roles = 0, enclosing = null, unknown = false }) {
  return Buffer.concat([
    packed(1, range),
    lfield(2, symbol),
    ...(roles ? [vfield(3, roles)] : []),
    ...(enclosing ? [packed(7, enclosing)] : []),
    lfield(4, 'documentation the reader does not use'),
    ...(unknown ? [unknownFields(60)] : []),
  ]);
}

export function relationship({ symbol, implementation = false, reference = false, typeDefinition = false, definition = false, unknown = false }) {
  return Buffer.concat([
    lfield(1, symbol),
    ...(reference ? [vfield(2, 1)] : []),
    ...(implementation ? [vfield(3, 1)] : []),
    ...(typeDefinition ? [vfield(4, 1)] : []),
    ...(definition ? [vfield(5, 1)] : []),
    ...(unknown ? [unknownFields(70)] : []),
  ]);
}

export function symbolInfo({ symbol, kind = 0, displayName = '', enclosing = '', relationships = [], unknown = false }) {
  return Buffer.concat([
    lfield(1, symbol),
    lfield(3, 'documentation'),
    ...relationships.map((r) => lfield(4, relationship(r))),
    ...(kind ? [vfield(5, kind)] : []),
    ...(displayName ? [lfield(6, displayName)] : []),
    ...(enclosing ? [lfield(8, enclosing)] : []),
    ...(unknown ? [unknownFields(80)] : []),
  ]);
}

export function document({ path, language = 'csharp', occurrences = [], symbols = [], unknown = false }) {
  return Buffer.concat([
    lfield(1, path),
    ...occurrences.map((o) => lfield(2, occurrence(o))),
    ...symbols.map((s) => lfield(3, symbolInfo(s))),
    lfield(4, language),
    lfield(5, 'document text the reader does not use'),
    vfield(6, 1),
    ...(unknown ? [unknownFields(50)] : []),
  ]);
}

export function index({ projectRoot = '', tool = { name: 'scip-test', version: '0.0.1' }, documents = [], external = [], unknown = false }) {
  const metadata = Buffer.concat([
    vfield(1, 0),
    lfield(2, Buffer.concat([lfield(1, tool.name), lfield(2, tool.version), lfield(3, '--flag')])),
    ...(projectRoot ? [lfield(3, projectRoot)] : []),
    vfield(4, 1),
    ...(unknown ? [unknownFields(40)] : []),
  ]);
  return Buffer.concat([
    lfield(1, metadata),
    ...(unknown ? [unknownFields(30)] : []),
    ...documents.map((d) => lfield(2, d)),
    ...external.map((s) => lfield(3, symbolInfo(s))),
    ...(unknown ? [unknownFields(100)] : []),
  ]);
}

export const writeIndex = (path, opts) => writeFileSync(path, index(opts));

/** A scip-dotnet style symbol for a C# member: `sym('Shop', 'OrderService', 'Notifier.')`. */
export const sym = (ns, type, member = '') => `scip-dotnet nuget . . ${ns}/${type}#${member}`;
