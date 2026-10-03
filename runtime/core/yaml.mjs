// A safe, strict YAML subset parser and a deterministic serializer.
//
// Why a subset: Unknot reads CI, Kubernetes, compose and CloudFormation files that other
// people wrote, so the parser must be bounded (depth, node count, alias expansion) and must
// refuse anything ambiguous instead of guessing. Resolution follows the YAML 1.2 CORE schema
// only, so `on`, `yes` and `no` stay strings (GitHub Actions' `on:` key is the string "on").
//
// Supported: block and flow collections, plain/quoted/block scalars with folding, comments,
// multi-document streams, anchors/aliases/merge keys, standard tags, and (opt-in) the
// CloudFormation short-form tags or verbatim tag preservation.
// Rejected on purpose: tab indentation, duplicate keys, complex keys (`? `), unknown tags
// (in the default mode), and anything exceeding the configured resource limits.
// Not supported: `%TAG` handle expansion (directives are skipped), `!!set/!!omap/!!binary/
// !!timestamp` semantics, multi-line implicit keys, and integers beyond 2^53 (they become
// the nearest double, like JSON).

/** A parse failure with a 1-based position. */
export class YAMLError extends Error {
  /**
   * @param {string} reason
   * @param {number} line 1-based
   * @param {number} column 1-based
   * @param {string} [filename]
   */
  constructor(reason, line, column, filename) {
    super(`${filename ? `${filename}: ` : ''}${reason} (line ${line}, column ${column})`);
    this.name = 'YAMLError';
    this.reason = reason;
    this.line = line;
    this.column = column;
    this.filename = filename ?? null;
  }
}

const EMPTY = Symbol('empty');
const FLOW_IND = ',[]{}';
const CORE_TAGS = new Set(['str', 'int', 'float', 'bool', 'null', 'map', 'seq']);
const CFN_FUNCTIONS = new Set([
  'Sub', 'Join', 'Select', 'If', 'Equals', 'Not', 'And', 'Or', 'FindInMap', 'Base64',
  'Cidr', 'ImportValue', 'Split', 'GetAZs', 'Transform', 'Length', 'ToJsonString',
]);

const INT_RE = /^[-+]?[0-9]+$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;
const OCT_RE = /^0o[0-7]+$/;
const FLOAT_RE = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;
const INF_RE = /^[-+]?\.(?:inf|Inf|INF)$/;
const NAN_RE = /^\.(?:nan|NaN|NAN)$/;

const isWs = (c) => c === ' ' || c === '\t';
// End of input counts as a separator so `key:` at EOF is a key with a null value.
const isSep = (c) => c === undefined || c === ' ' || c === '\t' || c === '\n';

function parseNumber(text) {
  if (INT_RE.test(text) || HEX_RE.test(text) || OCT_RE.test(text) || FLOAT_RE.test(text)) {
    return Number(text);
  }
  if (INF_RE.test(text)) return text[0] === '-' ? -Infinity : Infinity;
  if (NAN_RE.test(text)) return NaN;
  return undefined;
}

/** YAML 1.2 core-schema resolution of an unquoted scalar. */
function resolvePlain(text) {
  switch (text) {
    case '': case '~': case 'null': case 'Null': case 'NULL': return null;
    case 'true': case 'True': case 'TRUE': return true;
    case 'false': case 'False': case 'FALSE': return false;
    default: break;
  }
  const c = text.charCodeAt(0);
  // Only strings starting with a digit, sign or dot can be numbers; skip the regexes otherwise.
  if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
    const n = parseNumber(text);
    if (n !== undefined) return n;
  }
  return text;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// `__proto__` as a key must become an own property, never a prototype mutation.
function setOwn(obj, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    obj[key] = value;
  }
}

function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) setOwn(out, k, deepClone(v[k]));
    return out;
  }
  return v;
}

function cfnWrap(name, v) {
  if (name === 'Ref' || name === 'Condition') return { [name]: v };
  if (name === 'GetAtt') {
    if (typeof v === 'string') {
      const dot = v.indexOf('.');
      // Split on the first dot only: `A.Outputs.B` is resource `A`, attribute `Outputs.B`.
      return { 'Fn::GetAtt': dot < 0 ? [v] : [v.slice(0, dot), v.slice(dot + 1)] };
    }
    return { 'Fn::GetAtt': v };
  }
  return { [`Fn::${name}`]: v };
}

class Parser {
  constructor(text, o) {
    let s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    if (s.includes('\r')) s = s.replace(/\r\n?/g, '\n');
    this.s = s;
    this.len = s.length;
    this.o = o;
    this.i = 0;
    this.lastEnd = 0; // end of the last node's content, used to validate end-of-line
    this.lineStarts = [0];
    for (let k = 0; k < s.length; k++) if (s.charCodeAt(k) === 10) this.lineStarts.push(k + 1);
    this.depth = 0;
    this.nodes = 0;
    this.weight = 0; // nodes including alias expansion, to size anchors
    this.aliasUsed = 0;
    this.anchors = new Map();
    this.fl = { json: false, text: null };
  }

  // ---- positions and errors ------------------------------------------------------------

  pos(at) {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: at - this.lineStarts[lo] + 1 };
  }

  err(msg, at = this.i) {
    const { line, column } = this.pos(Math.min(at, this.len));
    throw new YAMLError(msg, line, column, this.o.filename);
  }

  col(at) {
    return at === 0 ? 0 : at - (this.s.lastIndexOf('\n', at - 1) + 1);
  }

  atLineStart(at) {
    return at === 0 || this.s[at - 1] === '\n';
  }

  isMarker(at, m) {
    return this.atLineStart(at) && this.s.startsWith(m, at) && isSep(this.s[at + 3]);
  }

  isDocBoundary(at) {
    return this.isMarker(at, '---') || this.isMarker(at, '...');
  }

  isSeqInd(at) {
    return this.s[at] === '-' && isSep(this.s[at + 1]);
  }

  countNode() {
    if (++this.nodes > this.o.maxNodes) this.err(`document exceeds the node limit of ${this.o.maxNodes}`);
    this.weight++;
  }

  enter(at) {
    if (++this.depth > this.o.maxDepth) this.err(`nesting deeper than the limit of ${this.o.maxDepth}`, at);
    this.countNode();
  }

  leave() {
    this.depth--;
  }

  // ---- whitespace ----------------------------------------------------------------------

  skipSpace() {
    const s = this.s;
    while (isWs(s[this.i])) this.i++;
    // A `#` only starts a comment after whitespace (or at line start), so `a#b` stays text.
    if (s[this.i] === '#' && (this.i === 0 || isWs(s[this.i - 1]) || s[this.i - 1] === '\n')) {
      while (this.i < this.len && s[this.i] !== '\n') this.i++;
    }
  }

  checkTabIndent() {
    const s = this.s;
    let j = this.i;
    while (s[j] === ' ') j++;
    if (s[j] !== '\t') return;
    let k = j;
    while (isWs(s[k])) k++;
    if (k < this.len && s[k] !== '\n' && s[k] !== '#') {
      this.err('tabs are not allowed for indentation', j);
    }
  }

  /** Skip blanks and comments to the next content; returns true if a newline was crossed. */
  skipToContent() {
    let crossed = false;
    for (;;) {
      if (this.atLineStart(this.i)) this.checkTabIndent();
      this.skipSpace();
      if (this.s[this.i] === '\n') {
        this.i++;
        crossed = true;
      } else {
        return crossed;
      }
    }
  }

  skipFlowWs() {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (isWs(c)) {
        this.i++;
      } else if (c === '\n') {
        this.i++;
        if (this.isDocBoundary(this.i)) this.err('unterminated flow collection (document marker reached)');
      } else if (c === '#' && (this.i === 0 || isWs(s[this.i - 1]) || s[this.i - 1] === '\n')) {
        while (this.i < this.len && s[this.i] !== '\n') this.i++;
      } else {
        return;
      }
    }
  }

  /** After a node, only whitespace and a comment may remain on its last line. */
  finishEntry() {
    const s = this.s;
    let j = this.lastEnd;
    if (j > 0 && s[j - 1] === '\n') return; // a block scalar consumed through its line break
    const from = j;
    while (isWs(s[j])) j++;
    if (s[j] === '#' && (j > from || isWs(s[from - 1]))) {
      while (j < this.len && s[j] !== '\n') j++;
    }
    if (j < this.len && s[j] !== '\n') this.err('unexpected content after value', j);
  }

  // ---- stream and documents ------------------------------------------------------------

  run() {
    const s = this.s;
    const docs = [];
    for (;;) {
      let directive = false;
      for (;;) {
        this.skipToContent();
        if (this.i >= this.len) break;
        if (s[this.i] === '%' && this.atLineStart(this.i)) {
          directive = true; // %YAML / %TAG are accepted and ignored
          while (this.i < this.len && s[this.i] !== '\n') this.i++;
          continue;
        }
        break;
      }
      if (this.i >= this.len) {
        if (directive) this.err('directive is not followed by a document');
        break;
      }
      const docStart = this.i;
      if (this.isMarker(this.i, '---')) {
        this.i += 3;
      } else if (this.isMarker(this.i, '...')) {
        if (directive) this.err('directive is not followed by a document');
        this.endMarker();
        continue;
      } else if (directive) {
        this.err("expected '---' after a directive");
      }
      this.anchors = new Map();
      this.depth = 0;
      this.lastEnd = this.i;
      const v = this.blockNode(-1, { root: true });
      if (v !== EMPTY) {
        this.finishEntry();
        docs.push({ value: v, pos: docStart });
      }
      this.skipToContent();
      if (this.i >= this.len) break;
      if (this.isMarker(this.i, '...')) {
        this.endMarker();
        continue;
      }
      if (this.isMarker(this.i, '---')) continue;
      this.err('unexpected content; check indentation');
    }
    return docs;
  }

  endMarker() {
    this.i += 3;
    this.skipSpace();
    if (this.i < this.len && this.s[this.i] !== '\n') this.err("unexpected content after '...'");
  }

  // ---- properties and tags -------------------------------------------------------------

  readProp(props) {
    const s = this.s;
    const at = this.i;
    props = props ?? { anchor: null, tagInfo: null };
    if (s[at] === '&') {
      if (props.anchor !== null) this.err('a node can have only one anchor', at);
      let j = at + 1;
      while (j < this.len && !isSep(s[j]) && !FLOW_IND.includes(s[j])) j++;
      if (j === at + 1) this.err('anchor name is empty', at);
      props.anchor = s.slice(at + 1, j);
      this.i = j;
    } else {
      if (props.tagInfo !== null) this.err('a node can have only one tag', at);
      let j;
      if (s[at + 1] === '<') {
        const close = s.indexOf('>', at + 2);
        if (close < 0 || s.slice(at, close).includes('\n')) this.err('unterminated verbatim tag', at);
        j = close + 1;
      } else {
        j = at + 1;
        while (j < this.len && !isSep(s[j]) && !FLOW_IND.includes(s[j])) j++;
      }
      props.tagInfo = this.classifyTag(s.slice(at, j), at);
      this.i = j;
    }
    return props;
  }

  classifyTag(text, pos) {
    if (text === '!') return { type: 'nonspecific', text, pos };
    let m = /^!!([A-Za-z]+)$/.exec(text) ?? /^!<tag:yaml\.org,2002:([A-Za-z]+)>$/.exec(text);
    if (m && CORE_TAGS.has(m[1])) return { type: 'core', name: m[1], text, pos };
    const mode = this.o.tags;
    if (mode === 'preserve') return { type: 'preserve', text, pos };
    if (mode === 'cloudformation') {
      m = /^!([A-Za-z0-9]+)$/.exec(text);
      if (m && (CFN_FUNCTIONS.has(m[1]) || m[1] === 'Ref' || m[1] === 'GetAtt' || m[1] === 'Condition')) {
        return { type: 'cfn', name: m[1], text, pos };
      }
    }
    return this.err(`unknown tag ${text}`, pos);
  }

  scalarWithTag(text, style, info) {
    if (!info) return style === 'plain' ? resolvePlain(text) : text;
    switch (info.type) {
      case 'nonspecific': return text;
      case 'preserve': return { __tag: info.text, value: style === 'plain' ? resolvePlain(text) : text };
      case 'cfn': return cfnWrap(info.name, text);
      default: return this.coreScalar(info, text);
    }
  }

  coreScalar(info, text) {
    const bad = () => this.err(`value ${JSON.stringify(text)} is not valid for ${info.text}`, info.pos);
    switch (info.name) {
      case 'str': return text;
      case 'int':
        if (INT_RE.test(text) || HEX_RE.test(text) || OCT_RE.test(text)) return Number(text);
        return bad();
      case 'float': {
        const n = parseNumber(text);
        return n === undefined ? bad() : n;
      }
      case 'bool': {
        const v = resolvePlain(text);
        return typeof v === 'boolean' ? v : bad();
      }
      case 'null':
        return text === '' || resolvePlain(text) === null ? null : bad();
      default:
        return this.err(`tag ${info.text} cannot be applied to a scalar`, info.pos);
    }
  }

  tagCollection(value, info) {
    if (!info) return value;
    const kind = Array.isArray(value) ? 'seq' : 'map';
    switch (info.type) {
      case 'nonspecific': return value;
      case 'preserve': return { __tag: info.text, value };
      case 'cfn': return cfnWrap(info.name, value);
      default:
        if (info.name === kind) return value;
        return this.err(`tag ${info.text} does not match a ${kind}`, info.pos);
    }
  }

  register(props, value, w0) {
    if (props?.anchor) this.anchors.set(props.anchor, { value, size: Math.max(1, this.weight - w0) });
  }

  makeScalar(text, style, props) {
    this.countNode();
    return this.scalarWithTag(text, style, props?.tagInfo ?? null);
  }

  emptyWithProps(props) {
    const w0 = this.weight;
    const v = this.makeScalar('', 'plain', props);
    this.register(props, v, w0);
    return v;
  }

  readAlias() {
    const s = this.s;
    const at = this.i;
    let j = at + 1;
    while (j < this.len && !isSep(s[j]) && !FLOW_IND.includes(s[j])) j++;
    const name = s.slice(at + 1, j);
    if (name === '') this.err('alias name is empty', at);
    const entry = this.anchors.get(name);
    if (!entry) this.err(`undefined alias *${name}`, at);
    this.aliasUsed += entry.size;
    if (this.aliasUsed > this.o.maxAliasExpansion) {
      this.err(`alias expansion exceeds the budget of ${this.o.maxAliasExpansion} nodes`, at);
    }
    this.weight += entry.size;
    this.countNode();
    this.i = j;
    this.lastEnd = j;
    return deepClone(entry.value);
  }

  // ---- block structure -----------------------------------------------------------------

  colOk(parentIndent, ctx) {
    const col = this.col(this.i);
    // A sequence may sit at the same indent as the mapping key that owns it.
    return col > parentIndent || (ctx.mapValue === true && col === parentIndent && this.isSeqInd(this.i));
  }

  blockNode(parentIndent, ctx) {
    const s = this.s;
    let crossed = this.skipToContent();
    if (this.i >= this.len || this.isDocBoundary(this.i)) return EMPTY;
    if (crossed && !this.colOk(parentIndent, ctx)) return EMPTY;
    const firstCol = this.col(this.i);
    let props = null;
    let propsCrossed = false;
    while (s[this.i] === '&' || s[this.i] === '!') {
      props = this.readProp(props);
      this.lastEnd = this.i;
      if (this.skipToContent()) {
        crossed = true;
        propsCrossed = true;
      }
      if (this.i >= this.len || this.isDocBoundary(this.i) || (propsCrossed && !this.colOk(parentIndent, ctx))) {
        return this.emptyWithProps(props);
      }
    }
    const c = s[this.i];
    const here = this.col(this.i);

    if (c === '-' && isSep(s[this.i + 1])) {
      if (props && !propsCrossed) this.err('properties must be on their own line before a block sequence');
      if (!crossed && ctx.mapValue) this.err('a block sequence cannot start on the same line as its key');
      const w0 = this.weight;
      const v = this.tagCollection(this.blockSeq(here), props?.tagInfo ?? null);
      this.register(props, v, w0);
      return v;
    }
    if (c === '?' && isSep(s[this.i + 1])) this.err("complex mapping keys ('? ') are not supported");

    if (c === '|' || c === '>') {
      const w0 = this.weight;
      this.countNode();
      const text = this.blockScalar(parentIndent);
      const v = this.scalarWithTag(text, 'block', props?.tagInfo ?? null);
      this.register(props, v, w0);
      return v;
    }

    const w0 = this.weight;
    const tok = this.readTok();
    let j = tok.end;
    while (isWs(s[j])) j++;
    if (s[j] === ':' && isSep(s[j + 1])) {
      if (ctx.mapValue && !crossed) this.err('a nested mapping must start on a new line', tok.start);
      if (tok.kind !== 'plain' && s.slice(tok.start, tok.end).includes('\n')) {
        this.err('implicit keys must fit on a single line', tok.start);
      }
      // Properties on the key's line belong to the key; on their own line, to the mapping.
      const keyOwnsProps = props !== null && !propsCrossed;
      const mapIndent = keyOwnsProps ? firstCol : here;
      const k = this.makeKey(tok, keyOwnsProps ? props : null, w0, j);
      const map = this.blockMap(mapIndent, k);
      const mapProps = keyOwnsProps ? null : props;
      const v = this.tagCollection(map, mapProps?.tagInfo ?? null);
      this.register(mapProps, v, w0);
      return v;
    }

    if (tok.kind === 'plain') {
      const cont = this.continuePlain(tok, parentIndent + 1, false);
      tok.text = cont.text;
      tok.end = cont.end;
    }
    const v = this.finalizeToken(tok, props, w0);
    this.i = tok.end;
    this.lastEnd = tok.end;
    return v;
  }

  finalizeToken(tok, props, w0) {
    let value;
    if (tok.kind === 'plain') value = this.makeScalar(tok.text, 'plain', props);
    else if (tok.kind === 'dq' || tok.kind === 'sq') value = this.makeScalar(tok.text, 'quoted', props);
    else if (tok.kind === 'flow') value = this.tagCollection(tok.value, props?.tagInfo ?? null);
    else {
      if (props) this.err('an alias cannot have properties', tok.start);
      value = tok.value;
    }
    this.register(props, value, w0);
    return value;
  }

  readTok() {
    const s = this.s;
    const start = this.i;
    const c = s[start];
    let tok;
    if (c === '"') {
      tok = { kind: 'dq', text: this.readDQ() };
    } else if (c === "'") {
      tok = { kind: 'sq', text: this.readSQ() };
    } else if (c === '[' || c === '{') {
      tok = { kind: 'flow', value: this.flowCollection() };
    } else if (c === '*') {
      tok = { kind: 'alias', value: this.readAlias() };
    } else {
      this.checkPlainStart(false);
      const r = this.scanPlain(false);
      this.i = r.end;
      tok = { kind: 'plain', text: r.text, stop: r.stop, rawEnd: r.rawEnd };
    }
    tok.start = start;
    tok.end = this.i;
    return tok;
  }

  checkPlainStart(flow) {
    const c = this.s[this.i];
    const n = this.s[this.i + 1];
    if (c === '@' || c === '`') this.err(`reserved indicator '${c}' cannot start a scalar`);
    if (c === '%') this.err("'%' cannot start a scalar; quote it");
    if (c === '|' || c === '>') this.err(`block scalar indicator '${c}' is not allowed here`);
    if ((c === '-' || c === '?' || c === ':') && (isSep(n) || (flow && FLOW_IND.includes(n)))) {
      this.err(`unexpected '${c}'`);
    }
    if (FLOW_IND.includes(c)) this.err(`unexpected '${c}'`);
  }

  /** Read one line of a plain scalar. `stop` says why it ended. */
  scanPlain(flow) {
    const s = this.s;
    const start = this.i;
    let j = start;
    let stop = 'eol';
    while (j < this.len) {
      const ch = s[j];
      if (ch === '\n') break;
      if (ch === ':') {
        const n = s[j + 1];
        if (isSep(n) || (flow && FLOW_IND.includes(n))) {
          stop = 'colon';
          break;
        }
      } else if (flow && FLOW_IND.includes(ch)) {
        stop = 'flowind';
        break;
      } else if (ch === '#' && j > start && isWs(s[j - 1])) {
        stop = 'comment';
        break;
      }
      j++;
    }
    let end = j;
    while (end > start && isWs(s[end - 1])) end--;
    return { text: s.slice(start, end), end, rawEnd: j, stop };
  }

  /** Fold following lines into a plain scalar (block: indented at least minCol). */
  continuePlain(tok, minCol, flow) {
    if (tok.stop !== 'eol') return { text: tok.text, end: tok.end };
    const s = this.s;
    let text = tok.text;
    let end = tok.end;
    let k = tok.rawEnd;
    let pending = 0;
    for (;;) {
      if (k >= this.len) break;
      const p = k + 1;
      let q = p;
      while (q < this.len && isWs(s[q])) q++;
      if (q >= this.len) break;
      if (s[q] === '\n') {
        pending++;
        k = q;
        continue;
      }
      let sp = p;
      while (s[sp] === ' ') sp++;
      if (!flow && sp - p < minCol) break;
      if (s[q] === '#') break; // a comment line ends the scalar
      if (this.isDocBoundary(p)) break;
      this.i = q;
      const r = this.scanPlain(flow);
      if (r.text === '') break;
      if (!flow && r.stop === 'colon') this.err('a mapping key cannot continue a multi-line plain scalar', q);
      text += (pending > 0 ? '\n'.repeat(pending) : ' ') + r.text;
      end = r.end;
      pending = 0;
      if (r.stop !== 'eol') break;
      k = r.rawEnd;
    }
    return { text, end };
  }

  makeKey(tok, props, w0, colonIdx) {
    let value;
    if (tok.kind === 'flow') this.err('flow collections cannot be mapping keys (complex key)', tok.start);
    if (tok.kind === 'plain') value = this.makeScalar(tok.text, 'plain', props);
    else if (tok.kind === 'alias') {
      if (props) this.err('an alias cannot have properties', tok.start);
      value = tok.value;
    } else value = this.makeScalar(tok.text, 'quoted', props);
    if (value !== null && typeof value === 'object') this.err('complex mapping keys are not supported', tok.start);
    const untaggedPlain = tok.kind === 'plain' && !props?.tagInfo;
    const key = typeof value === 'string' ? value : untaggedPlain ? tok.text : String(value);
    this.register(props, value, w0);
    return { key, isMerge: untaggedPlain && tok.text === '<<', pos: tok.start, colon: colonIdx };
  }

  readBlockKey() {
    const s = this.s;
    if (this.isSeqInd(this.i)) this.err('unexpected sequence entry; expected a mapping key');
    if (s[this.i] === '?' && isSep(s[this.i + 1])) this.err("complex mapping keys ('? ') are not supported");
    let props = null;
    while (s[this.i] === '&' || s[this.i] === '!') {
      props = this.readProp(props);
      this.skipSpace();
      if (this.i >= this.len || s[this.i] === '\n') this.err('expected a mapping key after node properties');
    }
    const w0 = this.weight;
    const tok = this.readTok();
    let j = tok.end;
    while (isWs(s[j])) j++;
    if (!(s[j] === ':' && isSep(s[j + 1]))) this.err("expected ':' after the mapping key", tok.start);
    if (tok.kind !== 'plain' && s.slice(tok.start, tok.end).includes('\n')) {
      this.err('implicit keys must fit on a single line', tok.start);
    }
    return this.makeKey(tok, props, w0, j);
  }

  blockMap(indent, first) {
    this.enter(first.pos);
    const map = {};
    const seen = new Set();
    const merges = [];
    let k = first;
    for (;;) {
      if (seen.has(k.key)) this.err(`duplicate key ${JSON.stringify(k.key)}`, k.pos);
      seen.add(k.key);
      this.i = k.colon + 1;
      this.lastEnd = this.i;
      const raw = this.blockNode(indent, { mapValue: true });
      const val = raw === EMPTY ? null : raw;
      if (k.isMerge) merges.push({ value: val, pos: k.pos });
      else setOwn(map, k.key, val);
      this.finishEntry();
      this.skipToContent();
      if (this.i >= this.len || this.isDocBoundary(this.i)) break;
      const col = this.col(this.i);
      if (col < indent) break;
      if (col > indent) this.err(`inconsistent indentation: expected column ${indent + 1}`);
      k = this.readBlockKey();
    }
    this.applyMerges(map, merges);
    this.leave();
    return map;
  }

  applyMerges(map, merges) {
    for (const m of merges) {
      const sources = Array.isArray(m.value) ? m.value : [m.value];
      for (const src of sources) {
        if (!isPlainObject(src)) this.err('merge key (<<) needs a mapping or a sequence of mappings', m.pos);
        // Explicit keys win, and so do earlier sources over later ones.
        for (const key of Object.keys(src)) {
          if (!Object.hasOwn(map, key)) setOwn(map, key, src[key]);
        }
      }
    }
  }

  blockSeq(indent) {
    this.enter(this.i);
    const arr = [];
    for (;;) {
      this.i++; // the '-'
      this.lastEnd = this.i;
      const v = this.blockNode(indent, { seqEntry: true });
      arr.push(v === EMPTY ? null : v);
      this.finishEntry();
      this.skipToContent();
      if (this.i >= this.len || this.isDocBoundary(this.i)) break;
      const col = this.col(this.i);
      if (col < indent) break;
      if (col > indent) this.err(`inconsistent indentation: expected column ${indent + 1}`);
      if (!this.isSeqInd(this.i)) break;
    }
    this.leave();
    return arr;
  }

  blockScalar(parentIndent) {
    const s = this.s;
    const folded = s[this.i] === '>';
    let j = this.i + 1;
    let chomp = 'clip';
    let chompSet = false;
    let explicit = 0;
    for (let n = 0; n < 2; n++) {
      const c = s[j];
      if (c === '-' || c === '+') {
        if (chompSet) this.err('duplicate chomping indicator', j);
        chompSet = true;
        chomp = c === '-' ? 'strip' : 'keep';
        j++;
      } else if (c >= '1' && c <= '9') {
        if (explicit) this.err('duplicate indentation indicator', j);
        explicit = Number(c);
        j++;
      } else {
        break;
      }
    }
    this.i = j;
    this.skipSpace();
    if (this.i < this.len && s[this.i] !== '\n') this.err('invalid block scalar header');
    let p = this.i < this.len ? this.i + 1 : this.len;

    let ci;
    if (explicit) {
      ci = (parentIndent >= 0 ? parentIndent : 0) + explicit;
    } else {
      let q = p;
      while (q < this.len) {
        let e = s.indexOf('\n', q);
        if (e < 0) e = this.len;
        let lead = 0;
        while (s[q + lead] === ' ') lead++;
        if (q + lead === e) {
          q = e + 1;
          continue;
        }
        if (lead >= parentIndent + 1) ci = lead;
        break;
      }
    }

    const lines = [];
    while (p < this.len) {
      let e = s.indexOf('\n', p);
      if (e < 0) e = this.len;
      let lead = 0;
      while (s[p + lead] === ' ') lead++;
      if (p + lead === e) {
        lines.push(ci !== undefined && lead > ci ? s.slice(p + ci, e) : '');
      } else {
        if (ci === undefined || lead < ci) break;
        if (lead === 0 && this.isDocBoundary(p)) break;
        lines.push(s.slice(p + ci, e));
      }
      p = e < this.len ? e + 1 : this.len;
    }
    this.i = p;
    this.lastEnd = p;

    let last = lines.length - 1;
    while (last >= 0 && lines[last] === '') last--;
    if (last < 0) return chomp === 'keep' ? '\n'.repeat(lines.length) : '';
    const content = lines.slice(0, last + 1);
    const trailing = lines.length - 1 - last;
    const body = folded ? foldLines(content) : content.join('\n');
    if (chomp === 'strip') return body;
    if (chomp === 'clip') return `${body}\n`;
    return body + '\n'.repeat(1 + trailing);
  }

  // ---- quoted scalars ------------------------------------------------------------------

  readDQ() {
    const s = this.s;
    const start = this.i;
    let i = start + 1;
    let out = '';
    let keep = 0; // length of `out` excluding trailing raw whitespace
    for (;;) {
      if (i >= this.len) this.err('unterminated double-quoted string', start);
      const c = s[i];
      if (c === '"') {
        i++;
        break;
      }
      if (c === '\\') {
        const n = s[i + 1];
        if (n === '\n') {
          // An escaped line break joins the lines with no space.
          i += 2;
          while (isWs(s[i])) i++;
          continue;
        }
        const esc = this.readEscape(i);
        out += esc.text;
        keep = out.length;
        i += esc.len;
        continue;
      }
      if (c === '\n') {
        i = this.foldBreak(i, start, 'double');
        out = out.slice(0, keep);
        out += this.pendingFold;
        keep = out.length;
        continue;
      }
      out += c;
      if (!isWs(c)) keep = out.length;
      i++;
    }
    this.i = i;
    return out;
  }

  readSQ() {
    const s = this.s;
    const start = this.i;
    let i = start + 1;
    let out = '';
    let keep = 0;
    for (;;) {
      if (i >= this.len) this.err('unterminated single-quoted string', start);
      const c = s[i];
      if (c === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          keep = out.length;
          i += 2;
          continue;
        }
        i++;
        break;
      }
      if (c === '\n') {
        i = this.foldBreak(i, start, 'single');
        out = out.slice(0, keep);
        out += this.pendingFold;
        keep = out.length;
        continue;
      }
      out += c;
      if (!isWs(c)) keep = out.length;
      i++;
    }
    this.i = i;
    return out;
  }

  /** Line folding inside a quoted scalar: one break is a space, extra breaks are newlines. */
  foldBreak(i, start, kind) {
    const s = this.s;
    let breaks = 0;
    while (s[i] === '\n' || isWs(s[i])) {
      if (s[i] === '\n') breaks++;
      i++;
    }
    if (i >= this.len) this.err(`unterminated ${kind}-quoted string`, start);
    if (this.isDocBoundary(i)) this.err(`unterminated ${kind}-quoted string (document marker reached)`, start);
    this.pendingFold = breaks === 1 ? ' ' : '\n'.repeat(breaks - 1);
    return i;
  }

  readEscape(i) {
    const s = this.s;
    const n = s[i + 1];
    const simple = {
      0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r',
      e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0',
      L: '\u2028', P: '\u2029',
    };
    if (n !== undefined && Object.hasOwn(simple, n)) return { text: simple[n], len: 2 };
    const width = n === 'x' ? 2 : n === 'u' ? 4 : n === 'U' ? 8 : 0;
    if (!width) this.err(`invalid escape sequence '\\${n ?? ''}'`, i);
    const hex = s.slice(i + 2, i + 2 + width);
    if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) this.err(`invalid \\${n} escape`, i);
    const cp = parseInt(hex, 16);
    if (cp > 0x10ffff) this.err('escape is not a valid code point', i);
    return { text: String.fromCodePoint(cp), len: 2 + width };
  }

  // ---- flow collections ----------------------------------------------------------------

  flowCollection() {
    return this.s[this.i] === '[' ? this.flowSeq() : this.flowMap();
  }

  flowColonOk(at) {
    const n = this.s[at + 1];
    return isSep(n) || FLOW_IND.includes(n);
  }

  flowKeyString(value, text, at) {
    if (value !== null && typeof value === 'object') this.err('complex mapping keys are not supported', at);
    return typeof value === 'string' ? value : text ?? String(value);
  }

  /** Parse any node inside a flow collection; sets `this.fl` for key handling. */
  flowNode() {
    const s = this.s;
    this.skipFlowWs();
    let props = null;
    while (s[this.i] === '&' || s[this.i] === '!') {
      props = this.readProp(props);
      this.skipFlowWs();
    }
    const w0 = this.weight;
    const c = s[this.i];
    let value;
    let json = false;
    let text = null;
    if (c === '[' || c === '{') {
      value = this.tagCollection(this.flowCollection(), props?.tagInfo ?? null);
      json = true;
    } else if (c === '"' || c === "'") {
      const t = c === '"' ? this.readDQ() : this.readSQ();
      value = this.makeScalar(t, 'quoted', props);
      json = true;
    } else if (c === '*') {
      if (props) this.err('an alias cannot have properties');
      value = this.readAlias();
    } else if (c === undefined || c === ',' || c === ']' || c === '}' || (c === ':' && this.flowColonOk(this.i))) {
      value = this.makeScalar('', 'plain', props);
    } else {
      this.checkPlainStart(true);
      const r = this.scanPlain(true);
      this.i = r.end;
      const cont = this.continuePlain(r, 0, true);
      this.i = cont.end;
      value = this.makeScalar(cont.text, 'plain', props);
      if (!props?.tagInfo) text = cont.text;
    }
    this.register(props, value, w0);
    this.fl = { json, text, merge: text === '<<' };
    this.lastEnd = this.i;
    return value;
  }

  flowSeq() {
    const s = this.s;
    const start = this.i;
    this.enter(start);
    this.i++;
    const arr = [];
    for (;;) {
      this.skipFlowWs();
      if (this.i >= this.len) this.err('unterminated flow sequence', start);
      if (s[this.i] === ']') {
        this.i++;
        break;
      }
      if (s[this.i] === ',') this.err("unexpected ',' in flow sequence");
      if (s[this.i] === '?' && isSep(s[this.i + 1])) this.err("complex mapping keys ('? ') are not supported");
      const entryAt = this.i;
      let entry = this.flowNode();
      const fl = this.fl;
      this.skipFlowWs();
      if (s[this.i] === ':' && (fl.json || this.flowColonOk(this.i))) {
        // `[a: b]` is a one-pair mapping.
        const key = this.flowKeyString(entry, fl.text, entryAt);
        this.i++;
        this.skipFlowWs();
        let val = null;
        if (s[this.i] !== ',' && s[this.i] !== ']') val = this.flowNode();
        this.countNode();
        entry = {};
        setOwn(entry, key, val);
        this.skipFlowWs();
      }
      arr.push(entry);
      if (s[this.i] === ',') this.i++;
      else if (s[this.i] === ']') continue;
      else if (this.i >= this.len) this.err('unterminated flow sequence', start);
      else this.err("expected ',' or ']' in flow sequence");
    }
    this.lastEnd = this.i;
    this.leave();
    return arr;
  }

  flowMap() {
    const s = this.s;
    const start = this.i;
    this.enter(start);
    this.i++;
    const map = {};
    const seen = new Set();
    const merges = [];
    for (;;) {
      this.skipFlowWs();
      if (this.i >= this.len) this.err('unterminated flow mapping', start);
      if (s[this.i] === '}') {
        this.i++;
        break;
      }
      if (s[this.i] === ',') this.err("unexpected ',' in flow mapping");
      if (s[this.i] === '?' && isSep(s[this.i + 1])) this.err("complex mapping keys ('? ') are not supported");
      const keyAt = this.i;
      const kv = this.flowNode();
      const fl = this.fl;
      this.skipFlowWs();
      let val = null;
      if (s[this.i] === ':' && (fl.json || this.flowColonOk(this.i))) {
        this.i++;
        this.skipFlowWs();
        if (s[this.i] !== ',' && s[this.i] !== '}') val = this.flowNode();
      }
      const key = this.flowKeyString(kv, fl.text, keyAt);
      if (seen.has(key)) this.err(`duplicate key ${JSON.stringify(key)}`, keyAt);
      seen.add(key);
      if (fl.merge && typeof kv === 'string') merges.push({ value: val, pos: keyAt });
      else setOwn(map, key, val);
      this.skipFlowWs();
      if (s[this.i] === ',') this.i++;
      else if (s[this.i] === '}') continue;
      else if (this.i >= this.len) this.err('unterminated flow mapping', start);
      else this.err("expected ',' or '}' in flow mapping");
    }
    this.applyMerges(map, merges);
    this.lastEnd = this.i;
    this.leave();
    return map;
  }
}

/** Fold a `>` block scalar: single breaks become spaces, more-indented lines keep theirs. */
function foldLines(lines) {
  let out = '';
  let prevMore = false;
  let prevText = false;
  let empties = 0;
  for (const line of lines) {
    if (line === '') {
      empties++;
      continue;
    }
    const more = line[0] === ' ' || line[0] === '\t';
    if (!prevText) out += '\n'.repeat(empties);
    else if (!more && !prevMore) out += empties === 0 ? ' ' : '\n'.repeat(empties);
    else out += '\n'.repeat(empties + 1);
    out += line;
    prevMore = more;
    prevText = true;
    empties = 0;
  }
  return out;
}

/**
 * Parse YAML text (YAML 1.2 core schema, strict subset).
 * @param {string} text
 * @param {{multi?: boolean, tags?: 'none'|'cloudformation'|'preserve', maxDepth?: number,
 *   maxNodes?: number, maxAliasExpansion?: number, filename?: string}} [opts]
 * @returns {any} One value, or an array of documents when `multi` is true.
 * @throws {YAMLError}
 */
export function parseYAML(text, opts = {}) {
  if (typeof text !== 'string') throw new TypeError('parseYAML expects a string');
  const o = {
    multi: false,
    tags: 'none',
    maxDepth: 64,
    maxNodes: 200000,
    maxAliasExpansion: 10000,
    filename: undefined,
    ...opts,
  };
  if (!['none', 'cloudformation', 'preserve'].includes(o.tags)) {
    throw new TypeError(`unknown tags mode ${JSON.stringify(o.tags)}`);
  }
  const parser = new Parser(text, o);
  let docs;
  try {
    docs = parser.run();
  } catch (e) {
    // Only reachable with a very large maxDepth; report it as the limit it really is.
    if (e instanceof RangeError) {
      throw new YAMLError('document is nested too deeply to parse', 1, 1, o.filename);
    }
    throw e;
  }
  if (o.multi) return docs.map((d) => d.value);
  if (docs.length > 1) {
    const { line, column } = parser.pos(docs[1].pos);
    throw new YAMLError('expected a single document but found several', line, column, o.filename);
  }
  return docs.length === 0 ? null : docs[0].value;
}

// ---- serializer --------------------------------------------------------------------------

const SPECIAL_RE = /[:#{}[\],&*!|>'"%@`]/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/;
const YAML11_WORDS_RE = /^(?:y|n|yes|no|on|off)$/i;

function needsQuote(str) {
  if (str === '') return true;
  if (/^\s|\s$/.test(str)) return true;
  if (SPECIAL_RE.test(str) || CONTROL_RE.test(str)) return true;
  if (str[0] === '-' || str[0] === '?' || str.startsWith('...') || str === '<<') return true;
  if (!str.isWellFormed()) return true;
  // Anything a reader would resolve to a non-string (null, bool, number) must be quoted.
  if (resolvePlain(str) !== str) return true;
  // YAML 1.1 readers treat these as booleans; quote so other tools agree with us.
  return YAML11_WORDS_RE.test(str);
}

function quoteString(str) {
  return JSON.stringify(str).replace(
    /[\u007f-\u009f\u2028\u2029\ufeff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function fmtString(str) {
  return needsQuote(str) ? quoteString(str) : str;
}

function fmtNumber(n) {
  if (Number.isNaN(n)) return '.nan';
  if (n === Infinity) return '.inf';
  if (n === -Infinity) return '-.inf';
  if (Object.is(n, -0)) return '-0';
  return String(n);
}

function liveKeys(obj) {
  return Object.keys(obj).filter((k) => obj[k] !== undefined);
}

function assertSerializable(v) {
  const proto = Object.getPrototypeOf(v);
  if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) {
    throw new TypeError('stringifyYAML only supports plain objects and arrays');
  }
}

/** Inline text for scalars and empty collections; null when a block is needed. */
function inlineText(v) {
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'string': return fmtString(v);
    case 'number': return fmtNumber(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'bigint': return String(v);
    case 'object':
      assertSerializable(v);
      if (Array.isArray(v)) return v.length === 0 ? '[]' : null;
      return liveKeys(v).length === 0 ? '{}' : null;
    default:
      throw new TypeError(`cannot serialize a value of type ${typeof v}`);
  }
}

function blockLines(v, indent, stack) {
  if (stack.has(v)) throw new TypeError('cannot serialize a circular structure');
  stack.add(v);
  const pad = ' '.repeat(indent);
  const out = [];
  if (Array.isArray(v)) {
    for (const item of v) {
      const t = inlineText(item);
      if (t !== null) {
        out.push(`${pad}- ${t}`);
      } else {
        // Compact form: the child's first line shares the dash line (`- a: 1`, `- - x`).
        const sub = blockLines(item, indent + 2, stack);
        sub[0] = `${pad}- ${sub[0].slice(indent + 2)}`;
        out.push(...sub);
      }
    }
  } else {
    for (const k of liveKeys(v)) {
      const t = inlineText(v[k]);
      if (t !== null) {
        out.push(`${pad}${fmtString(k)}: ${t}`);
      } else {
        out.push(`${pad}${fmtString(k)}:`);
        out.push(...blockLines(v[k], indent + 2, stack));
      }
    }
  }
  stack.delete(v);
  return out;
}

/**
 * Serialize a JSON-compatible value as deterministic block-style YAML.
 * Keys keep insertion order; strings are double-quoted whenever a plain scalar would not
 * read back as the same string.
 * @param {any} value
 * @returns {string}
 */
export function stringifyYAML(value) {
  const t = inlineText(value);
  if (t !== null) return `${t}\n`;
  return `${blockLines(value, 0, new Set()).join('\n')}\n`;
}
