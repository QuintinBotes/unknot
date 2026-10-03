// A tolerant HCL2 parser. Terraform in the wild is half-edited, templated and sometimes
// plain wrong, and a mapper that dies on one bad file maps nothing, so this parser never
// throws: it returns what it understood plus a list of what it did not.
//
// Value model (deliberately small):
//   string/number/boolean/null   literals (a quoted string without interpolation is a JS string)
//   Array                        list/tuple
//   plain object                 object constructor `{ a = 1 }`
//   { expr: '<raw text>' }       anything not a literal: references, function calls,
//                                operators, templates with ${...} or %{...}, for-expressions
// Heredocs are returned as strings (their raw text). Repository text is data: nothing here
// evaluates anything.

/** @typedef {{line: number, message: string}} HclError */
/** @typedef {{attributes: Record<string, {value: any, line: number}>, blocks: HclBlock[]}} HclBody */
/** @typedef {{type: string, labels: string[], body: HclBody, line: number}} HclBlock */

const MAX_DEPTH = 64;
const NUMBER_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const TEMPLATE_RE = /(?<![$%])[$%]\{/;

/** True for the `{expr}` wrapper this parser uses for non-literal values. */
export function isExpr(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.expr === 'string' && Object.keys(v).length === 1;
}

class Parser {
  constructor(src) {
    this.s = src;
    this.n = src.length;
    this.i = 0;
    /** @type {HclError[]} */
    this.errors = [];
    this.lineStarts = [0];
    for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) this.lineStarts.push(k + 1);
    this.depth = 0;
  }

  lineAt(pos) {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  err(message, pos = this.i) {
    if (this.errors.length < 200) this.errors.push({ line: this.lineAt(pos), message });
  }

  /** Skip spaces and tabs only (a newline ends a statement). */
  skipSpaces() {
    while (this.i < this.n && (this.s[this.i] === ' ' || this.s[this.i] === '\t' || this.s[this.i] === '\r')) this.i++;
  }

  /** Skip whitespace, newlines and all three comment styles. */
  skipTrivia() {
    for (;;) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') this.i++;
      else if (c === '#' || (c === '/' && this.s[this.i + 1] === '/')) this.skipLine();
      else if (c === '/' && this.s[this.i + 1] === '*') {
        const end = this.s.indexOf('*/', this.i + 2);
        if (end < 0) {
          this.err('unterminated block comment');
          this.i = this.n;
        } else this.i = end + 2;
      } else return;
    }
  }

  skipLine() {
    while (this.i < this.n && this.s[this.i] !== '\n') this.i++;
  }

  /** Index just past a quoted string starting at `at`; stops at a newline when unterminated. */
  skipString(at) {
    let j = at + 1;
    while (j < this.n) {
      const c = this.s[j];
      if (c === '\\') j += 2;
      else if (c === '"') return j + 1;
      else if (c === '\n') {
        this.err('unterminated string', at);
        return j;
      } else if (c === '$' && this.s[j + 1] === '$' && this.s[j + 2] === '{') j += 3;
      else if ((c === '$' || c === '%') && this.s[j + 1] === '{') j = this.skipBraces(j + 1);
      else j++;
    }
    this.err('unterminated string', at);
    return this.n;
  }

  /** Index just past the `}` matching the `{` at `at`, honouring nested strings. */
  skipBraces(at) {
    let depth = 0;
    let j = at;
    while (j < this.n) {
      const c = this.s[j];
      if (c === '"') j = this.skipString(j);
      else {
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return j + 1;
        j++;
      }
    }
    return this.n;
  }

  parseBody(untilBrace) {
    /** @type {HclBody} */
    const body = { attributes: {}, blocks: [] };
    for (;;) {
      this.skipTrivia();
      if (this.i >= this.n) {
        if (untilBrace) this.err('unclosed block');
        return body;
      }
      const c = this.s[this.i];
      if (c === '}') {
        this.i++;
        if (untilBrace) return body;
        this.err('unexpected }');
        continue;
      }
      if (!/[A-Za-z_]/.test(c)) {
        this.err(`unexpected character ${JSON.stringify(c)}`);
        this.skipLine();
        continue;
      }
      const before = this.i;
      const line = this.lineAt(this.i);
      const name = this.readIdent();
      this.skipSpaces();
      if (this.s[this.i] === '=' && this.s[this.i + 1] !== '=') {
        this.i++;
        const value = this.parseValue(false);
        body.attributes[name] = { value, line };
        this.endStatement();
      } else {
        const labels = [];
        for (;;) {
          this.skipSpaces();
          const d = this.s[this.i];
          if (d === '"') {
            const end = this.skipString(this.i);
            labels.push(unquote(this.s.slice(this.i, end)));
            this.i = end;
          } else if (d !== undefined && /[A-Za-z_]/.test(d)) labels.push(this.readIdent());
          else break;
        }
        if (this.s[this.i] === '{') {
          this.i++;
          this.depth++;
          const sub = this.depth > MAX_DEPTH ? this.rawBlock() : this.parseBody(true);
          this.depth--;
          body.blocks.push({ type: name, labels, body: sub, line });
        } else {
          this.err(`expected '=' or '{' after ${name}`);
          this.skipLine();
        }
      }
      if (this.i === before) this.i++; // progress guarantee on any garbage
    }
  }

  /** Past MAX_DEPTH: skip the block rather than recurse (and risk the stack). */
  rawBlock() {
    this.err('block nesting too deep');
    this.i = this.skipBraces(this.i - 1);
    return { attributes: {}, blocks: [] };
  }

  readIdent() {
    const start = this.i;
    while (this.i < this.n && /[A-Za-z0-9_-]/.test(this.s[this.i])) this.i++;
    return this.s.slice(start, this.i);
  }

  endStatement() {
    this.skipSpaces();
    const c = this.s[this.i];
    if (c === undefined || c === '}') return;
    if (c === '\n') {
      this.i++;
      return;
    }
    if (c === '#' || (c === '/' && (this.s[this.i + 1] === '/' || this.s[this.i + 1] === '*'))) return;
    this.err('unexpected text after value');
    this.skipLine();
  }

  /** True when the next significant char ends a value in the current context. */
  atTerminator() {
    this.skipSpaces();
    const c = this.s[this.i];
    if (c === undefined || c === '\n' || c === ',' || c === '}' || c === ']' || c === ')' || c === '#') return true;
    return c === '/' && (this.s[this.i + 1] === '/' || this.s[this.i + 1] === '*');
  }

  parseValue(inContainer) {
    if (inContainer) this.skipTrivia();
    else this.skipSpaces();
    const start = this.i;
    const errCount = this.errors.length;
    const c = this.s[this.i];
    let value;
    let literal = true;
    if (this.depth > MAX_DEPTH) literal = false;
    else if (c === '"') value = this.parseQuoted();
    else if (c === '[' || c === '{') {
      if (this.looksLikeFor(start + 1)) literal = false;
      else {
        this.depth++;
        value = c === '[' ? this.parseList() : this.parseObject();
        this.depth--;
      }
    } else if (c === '<' && this.s[this.i + 1] === '<') {
      const h = this.parseHeredoc();
      if (h === undefined) literal = false;
      else value = h;
    } else {
      const m = NUMBER_RE.exec(this.s.slice(this.i, this.i + 40));
      const word = /^(true|false|null)(?![\w.-])/.exec(this.s.slice(this.i, this.i + 8));
      if (m) {
        value = Number(m[0]);
        this.i += m[0].length;
      } else if (word) {
        value = word[1] === 'null' ? null : word[1] === 'true';
        this.i += word[1].length;
      } else literal = false;
    }
    if (literal && value !== undefined && this.atTerminator()) return value;
    // Not a clean literal (operator, call, reference, conditional...): keep the source text.
    this.i = start;
    this.errors.length = errCount;
    return this.rawExpr(inContainer);
  }

  looksLikeFor(from) {
    let j = from;
    while (j < this.n && /\s/.test(this.s[j])) j++;
    return /^for\s/.test(this.s.slice(j, j + 4));
  }

  parseQuoted() {
    const end = this.skipString(this.i);
    const raw = this.s.slice(this.i, end);
    this.i = end;
    return TEMPLATE_RE.test(raw) ? { expr: raw } : unquote(raw);
  }

  /** Heredoc `<<TAG` / `<<-TAG`. Returns undefined when it is not one. */
  parseHeredoc() {
    const m = /^<<(-?)([A-Za-z_]\w*)[ \t]*\r?\n/.exec(this.s.slice(this.i, this.i + 200));
    if (!m) return undefined;
    const tag = m[2];
    const lines = [];
    let j = this.i + m[0].length;
    let closed = false;
    while (j < this.n) {
      let e = this.s.indexOf('\n', j);
      if (e < 0) e = this.n;
      const line = this.s.slice(j, e).replace(/\r$/, '');
      if (line.trim() === tag) {
        closed = true;
        j = e;
        break;
      }
      lines.push(line);
      j = e + 1;
    }
    if (!closed) this.err(`unterminated heredoc <<${tag}`);
    this.i = Math.min(j, this.n);
    let out = lines;
    if (m[1] === '-') {
      const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length);
      const cut = indents.length ? Math.min(...indents) : 0;
      out = lines.map((l) => l.slice(cut));
    }
    return out.length ? `${out.join('\n')}\n` : '';
  }

  parseList() {
    const out = [];
    this.i++;
    for (;;) {
      this.skipTrivia();
      if (this.i >= this.n) {
        this.err('unclosed list');
        return out;
      }
      const c = this.s[this.i];
      if (c === ']') {
        this.i++;
        return out;
      }
      if (c === ',') {
        this.i++;
        continue;
      }
      const before = this.i;
      out.push(this.parseValue(true));
      this.skipTrivia();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== ']' && this.i === before) {
        this.err('unexpected token in list');
        this.i++;
      }
    }
  }

  parseObject() {
    const out = {};
    this.i++;
    for (;;) {
      this.skipTrivia();
      if (this.i >= this.n) {
        this.err('unclosed object');
        return out;
      }
      const c = this.s[this.i];
      if (c === '}') {
        this.i++;
        return out;
      }
      if (c === ',') {
        this.i++;
        continue;
      }
      const before = this.i;
      let key;
      if (c === '"') {
        const end = this.skipString(this.i);
        key = unquote(this.s.slice(this.i, end));
        this.i = end;
      } else if (c === '(') {
        const end = this.scanBalanced(this.i);
        key = this.s.slice(this.i, end);
        this.i = end;
      } else {
        const start = this.i;
        while (this.i < this.n && !/[\s=:,}]/.test(this.s[this.i])) this.i++;
        key = this.s.slice(start, this.i);
      }
      this.skipSpaces();
      const sep = this.s[this.i];
      if ((sep === '=' && this.s[this.i + 1] !== '=') || sep === ':') {
        this.i++;
        const v = this.parseValue(true);
        // `__proto__` as a key would rewrite the prototype of the result; drop it.
        if (key !== '__proto__') out[key] = v;
      } else {
        this.err(`expected '=' or ':' after key ${JSON.stringify(key)}`);
        while (this.i < this.n && !/[\n,}]/.test(this.s[this.i])) this.i++;
      }
      if (this.i === before) this.i++;
    }
  }

  /** Index just past a balanced bracket group starting at `at`. */
  scanBalanced(at) {
    let depth = 0;
    let j = at;
    while (j < this.n) {
      const c = this.s[j];
      if (c === '"') {
        j = this.skipString(j);
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if ((c === ')' || c === ']' || c === '}') && --depth <= 0) return j + 1;
      j++;
    }
    return this.n;
  }

  /** Consume the rest of an expression as raw text and wrap it. */
  rawExpr(inContainer) {
    const start = this.i;
    let depth = 0;
    let j = this.i;
    while (j < this.n) {
      const c = this.s[j];
      if (c === '"') {
        j = this.skipString(j);
        continue;
      }
      if (c === '<' && this.s[j + 1] === '<' && /^<<-?[A-Za-z_]\w*[ \t]*\r?\n/.test(this.s.slice(j, j + 100))) {
        const save = this.i;
        this.i = j;
        const h = this.parseHeredoc();
        j = h === undefined ? j + 2 : this.i;
        this.i = save;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0) {
        if (c === '\n') break;
        if (c === ',' && inContainer) break;
        if (c === '#' || (c === '/' && this.s[j + 1] === '/')) break;
      }
      if (c === '/' && this.s[j + 1] === '*') {
        const end = this.s.indexOf('*/', j + 2);
        j = end < 0 ? this.n : end + 2;
        continue;
      }
      j++;
    }
    // A stray closer at depth zero: consume it so the caller always makes progress.
    if (j === start && j < this.n) j++;
    this.i = j;
    const raw = this.s.slice(start, j).trim();
    if (!raw) this.err('missing expression');
    return { expr: raw };
  }
}

/** Decode a quoted literal (`"..."`) without interpolation. */
function unquote(raw) {
  const inner = raw.endsWith('"') && raw.length >= 2 ? raw : `${raw}"`;
  try {
    return JSON.parse(inner);
  } catch {
    return inner.slice(1, -1);
  }
}

/**
 * Parse HCL2 text. Never throws.
 * @param {string} text
 * @returns {{body: HclBody, errors: HclError[]}}
 */
export function parseHCL(text) {
  const src = typeof text === 'string' ? text.replace(/^﻿/, '') : '';
  const p = new Parser(src);
  let body = { attributes: {}, blocks: [] };
  try {
    body = p.parseBody(false);
  } catch (e) {
    p.err(`parser failure: ${e && e.message ? e.message : String(e)}`);
  }
  return { body, errors: p.errors };
}

/**
 * Parse one standalone expression/value (for example the argument of `jsonencode(...)`).
 * Never throws.
 * @param {string} text
 * @returns {any} A value in the model described at the top of this file.
 */
export function parseExpression(text) {
  const p = new Parser(String(text ?? ''));
  try {
    return p.parseValue(true);
  } catch {
    return { expr: String(text ?? '').trim() };
  }
}

/**
 * If `v` is `jsonencode(<literal-ish>)`, return the parsed argument; otherwise undefined.
 * Unresolved references inside stay as `{expr}` leaves.
 */
export function unwrapJsonencode(v) {
  if (!isExpr(v)) return undefined;
  const m = /^jsonencode\(([\s\S]*)\)$/.exec(v.expr.trim());
  return m ? parseExpression(m[1]) : undefined;
}

/** All blocks of one type. */
export function blocksOf(body, type) {
  return body.blocks.filter((b) => b.type === type);
}

/**
 * Flatten a block body into a plain object: attributes keep their value model and nested
 * blocks become arrays of plain objects under their type name. Labels land in `__labels`.
 */
export function bodyToPlain(body, depth = 0) {
  const out = {};
  for (const [k, a] of Object.entries(body.attributes)) if (k !== '__proto__') out[k] = a.value;
  if (depth > 16) return out;
  for (const b of body.blocks) {
    const plain = bodyToPlain(b.body, depth + 1);
    if (b.labels.length) plain.__labels = b.labels;
    // Own-property check: a block named `constructor` must not find Object's, and an attribute
    // with the same name as a block must not be pushed onto.
    if (!Object.hasOwn(out, b.type) || !Array.isArray(out[b.type])) out[b.type] = Object.hasOwn(out, b.type) ? [out[b.type]] : [];
    out[b.type].push(plain);
  }
  return out;
}
