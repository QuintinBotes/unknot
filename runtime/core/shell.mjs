// Fail-closed shell parser for the PreToolUse hook.
//
// `parseShell` turns the string a model wants to run with the Bash tool into a flat list of
// simple commands. It never executes anything and never guesses: whenever the text uses a
// construct whose meaning it cannot pin down with certainty, it returns `ok: false` and the
// policy layer denies. Over-rejecting is cheap; one mis-parsed `rm` is not.
//
// Returns ok:false for: unbalanced quotes/parens/braces, NUL bytes, input over `maxLength`,
// nesting over `maxDepth`, `(( ))` arithmetic commands and `for ((;;))` loops, array
// assignments (`a=(x)`), legacy `$[ ]` arithmetic, `${x@P}` prompt expansion, quotes inside
// `$(( ))`, NUL bytes produced by `$'\x00'`, unterminated heredocs, and any syntax error
// (stray `then`/`fi`/`}`/`)`/`;;`, empty compound bodies, missing `do`/`done`/`esac`...).
//
// `effectiveCommands` then looks through wrappers (`env`, `sudo`, `xargs`, `sh -c`, `eval`,
// `find -exec`...) so the policy sees what will really run.

/** @typedef {{ value: string, dynamic: boolean, glob: boolean, quoted: boolean }} Word */
/**
 * @typedef {{
 *   argv: Word[],
 *   assignments: { name: string, value: Word }[],
 *   redirects: { fd: number|null, op: string, target: Word, heredoc?: string, heredocDynamic?: boolean }[],
 *   context: { pipeline: boolean, background: boolean, subshell: boolean, substitution: boolean,
 *              negated: boolean, viaWrapper?: string, fromStdin?: boolean }
 * }} SimpleCommand
 */

const MAX_UNWRAP_DEPTH = 8;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REDIR_OPS = new Set(['>', '>>', '<', '<<', '<<-', '<<<', '>&', '<&', '&>', '&>>', '>|', '<>']);
const COMPOUND_STARTS = new Set(['if', 'while', 'until', 'for', 'select', 'case', '{', '[[']);
// Reserved words that can never begin a command; seeing one there is a syntax error.
const STRAY_RESERVED = new Set(['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}']);

class ShellError extends Error {}

function fail(message) {
  throw new ShellError(message);
}

function mkWord(value, f = {}) {
  return { value, dynamic: Boolean(f.dynamic), glob: Boolean(f.glob), quoted: Boolean(f.quoted) };
}

/** Mutable accumulator for one shell word while it is being lexed. */
function newBuilder() {
  return {
    value: '', dynamic: false, glob: false, quoted: false,
    bare: true, // only plain unquoted literal characters so far (a candidate reserved word)
    started: false,
    plain: '', plainOpen: true, // leading literal run, used to spot NAME=value
    assignName: null, valueStart: 0, afterAssign: false,
    bracket: false, braces: [],
  };
}

/**
 * Decode the body of `$'...'` starting just after the opening quote.
 * Bytes are accumulated as bytes so `$'\xc3\xa9'` decodes the way bash does.
 */
function decodeAnsiC(s, i) {
  const chunks = [];
  let lit = '';
  const flush = () => {
    if (lit) chunks.push(Buffer.from(lit, 'utf8'));
    lit = '';
  };
  const byte = (b) => {
    flush();
    chunks.push(Buffer.from([b & 0xff]));
  };
  const simple = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
  for (;;) {
    const c = s[i];
    if (c === undefined) fail("unterminated $'...' string");
    if (c === "'") {
      i++;
      break;
    }
    if (c !== '\\') {
      lit += c;
      i++;
      continue;
    }
    const n = s[i + 1];
    if (n === undefined) fail("unterminated $'...' string");
    i += 2;
    if (Object.hasOwn(simple, n)) {
      lit += simple[n];
    } else if (n === 'x') {
      const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i, i + 2));
      if (m) {
        byte(parseInt(m[0], 16));
        i += m[0].length;
      } else lit += '\\x';
    } else if (n === 'u' || n === 'U') {
      const m = new RegExp(`^[0-9a-fA-F]{1,${n === 'u' ? 4 : 8}}`).exec(s.slice(i, i + 8));
      if (m) {
        const cp = parseInt(m[0], 16);
        if (cp > 0x10ffff) fail('invalid unicode escape');
        lit += String.fromCodePoint(cp);
        i += m[0].length;
      } else lit += `\\${n}`;
    } else if (n === 'c') {
      const x = s[i];
      if (x === undefined) fail("unterminated $'...' string");
      i++;
      byte(x === '?' ? 0x7f : x.charCodeAt(0) & 0x1f);
    } else if (n >= '0' && n <= '7') {
      const m = /^[0-7]{0,2}/.exec(s.slice(i, i + 2));
      byte(parseInt(n + m[0], 8));
      i += m[0].length;
    } else {
      lit += `\\${n}`;
    }
  }
  flush();
  const buf = Buffer.concat(chunks);
  // Bash truncates a word at an embedded NUL, so the real argv would differ from ours.
  if (buf.includes(0)) fail("NUL byte in $'...' string");
  return { str: buf.toString('utf8'), end: i };
}

class Parser {
  constructor(src, pos, { depth, maxDepth, substitution }) {
    this.src = src;
    this.pos = pos;
    this.depth = depth;
    this.maxDepth = maxDepth;
    this.substitution = substitution;
    this.out = [];
    this.adopted = new Set(); // commands that came from a nested substitution
    this.buf = []; // token lookahead
    this.heredocs = []; // heredocs whose bodies start after the next newline
    this.subshell = 0;
    this.cond = false; // inside [[ ]]
  }

  /** Parser over another text (or this text from `pos`) for substitutions. */
  child(src, pos) {
    if (this.depth + 1 > this.maxDepth) fail('nesting too deep');
    return new Parser(src, pos, { depth: this.depth + 1, maxDepth: this.maxDepth, substitution: true });
  }

  adopt(sub) {
    for (const c of sub.out) {
      this.out.push(c);
      this.adopted.add(c);
    }
  }

  // ---- tokens ---------------------------------------------------------------------------

  peek() {
    if (!this.buf.length) this.buf.push(this.lex());
    return this.buf[0];
  }

  take() {
    const t = this.peek();
    this.buf.shift();
    return t;
  }

  skipNewlines() {
    while (this.peek().t === 'nl') this.take();
  }

  lex() {
    const s = this.src;
    const idx = this.out.length; // commands emitted from here on belong to this token's statement
    for (;;) {
      const c = s[this.pos];
      if (c === ' ' || c === '\t') this.pos++;
      else if (c === '\\' && s[this.pos + 1] === '\n') this.pos += 2;
      else if (c === '#') {
        // A comment can only start where a token could; `a#b` is lexed inside readWord.
        while (this.pos < s.length && s[this.pos] !== '\n') this.pos++;
      } else break;
    }
    const tok = this.lexToken(s[this.pos]);
    tok.idx = idx;
    return tok;
  }

  lexToken(c) {
    const s = this.src;
    if (c === undefined) return { t: 'eof' };
    if (c === '\n') {
      this.pos++;
      if (this.heredocs.length) this.readHeredocBodies();
      return { t: 'nl' };
    }
    if (this.cond) {
      if (c === '(' || c === ')') {
        this.pos++;
        return { t: 'word', word: mkWord(c), bare: false, assign: null };
      }
      if (c === ';') fail("';' inside [[ ]]");
      return this.readWord();
    }
    let fd = null;
    if (c >= '0' && c <= '9') {
      let j = this.pos;
      while (s[j] >= '0' && s[j] <= '9') j++;
      if ((s[j] === '<' || s[j] === '>') && s[j + 1] !== '(' && j - this.pos <= 9) {
        fd = Number(s.slice(this.pos, j));
        this.pos = j;
        c = s[j];
      }
    }
    const at = (str) => s.startsWith(str, this.pos);
    const op = (v, extra = {}) => {
      this.pos += v.length;
      return { t: 'op', v, fd, ...extra };
    };
    switch (c) {
      case ';':
        return at(';;&') ? op(';;&') : at(';;') ? op(';;') : at(';&') ? op(';&') : op(';');
      case '&':
        return at('&&') ? op('&&') : at('&>>') ? op('&>>') : at('&>') ? op('&>') : op('&');
      case '|':
        return at('||') ? op('||') : at('|&') ? op('|&') : op('|');
      case '(':
        return op('(', { dbl: s[this.pos + 1] === '(' });
      case ')':
        return op(')');
      case '<':
        if (at('<(')) return this.readWord();
        return at('<<<') ? op('<<<') : at('<<-') ? op('<<-') : at('<<') ? op('<<')
          : at('<&') ? op('<&') : at('<>') ? op('<>') : op('<');
      case '>':
        if (at('>(')) return this.readWord();
        return at('>>') ? op('>>') : at('>&') ? op('>&') : at('>|') ? op('>|') : op('>');
      default:
        return this.readWord();
    }
  }

  isBreak(c) {
    if (c === ' ' || c === '\t' || c === '\n' || c === '(' || c === ')' || c === ';') return true;
    if (this.cond) return false;
    return c === '&' || c === '|' || c === '<' || c === '>';
  }

  /** Read one word, resolving quotes, escapes and expansions. */
  readWord() {
    const s = this.src;
    const w = newBuilder();
    const start = this.pos;
    for (;;) {
      const c = s[this.pos];
      if (c === undefined) break;
      if (!this.cond && (c === '<' || c === '>') && s[this.pos + 1] === '(') {
        this.readProcSub(w);
        continue;
      }
      if (this.isBreak(c)) break;
      if (c === '\\') {
        const n = s[this.pos + 1];
        if (n === undefined) fail('trailing backslash');
        this.pos += 2;
        if (n === '\n') continue; // line continuation
        w.value += n;
        this.mark(w, true);
      } else if (c === "'") {
        const e = s.indexOf("'", this.pos + 1);
        if (e === -1) fail('unterminated single quote');
        w.value += s.slice(this.pos + 1, e);
        this.pos = e + 1;
        this.mark(w, true);
      } else if (c === '"') {
        this.pos++;
        this.readDQ(w, '"');
      } else if (c === '$') {
        this.readDollar(w, false);
      } else if (c === '`') {
        this.readBacktick(w, false);
      } else {
        this.literal(w, c);
        this.pos++;
      }
    }
    if (this.pos === start || !w.started) fail('unexpected character');
    const word = mkWord(w.value, w);
    const tok = { t: 'word', word, bare: w.bare, assign: null };
    if (w.assignName !== null) {
      tok.assign = { name: w.assignName, value: mkWord(w.value.slice(w.valueStart), w) };
    }
    return tok;
  }

  /** Bookkeeping for a character that is not a plain unquoted literal. */
  mark(w, quoted) {
    w.started = true;
    w.bare = false;
    w.plainOpen = false;
    w.afterAssign = false;
    if (quoted) w.quoted = true;
  }

  /** An unquoted literal character: tracks globs, braces, tildes and NAME= prefixes. */
  literal(w, c) {
    const tilde = c === '~' && (!w.started || w.afterAssign || (w.assignName !== null && w.value.endsWith(':')));
    w.afterAssign = false;
    if (tilde) w.dynamic = true;
    if (c === '*' || c === '?') w.glob = true;
    else if (c === '[') w.bracket = true;
    else if (c === ']' && w.bracket) w.glob = true;
    else if (c === '{') w.braces.push(false);
    else if (c === ',' && w.braces.length) w.braces[w.braces.length - 1] = true;
    else if (c === '.' && w.braces.length && w.value.endsWith('.')) w.braces[w.braces.length - 1] = true;
    else if (c === '}' && w.braces.length && w.braces.pop()) w.dynamic = true; // brace expansion
    if (c === '=' && w.plainOpen && w.assignName === null && /^[A-Za-z_][A-Za-z0-9_]*\+?$/.test(w.plain)) {
      if (this.src[this.pos + 1] === '(') fail('array assignment is not supported');
      w.assignName = w.plain.replace(/\+$/, '');
      w.value += c;
      w.started = true;
      w.valueStart = w.value.length;
      w.dynamic = false;
      w.glob = false;
      w.quoted = false;
      w.afterAssign = true;
      w.plainOpen = false;
      return;
    }
    if (w.plainOpen) w.plain += c;
    w.value += c;
    w.started = true;
  }

  /** Double-quote body. `term` is '"' or null for "until end of text" (heredocs, $(( ))). */
  readDQ(w, term) {
    const s = this.src;
    if (term === '"') this.mark(w, true);
    for (;;) {
      const c = s[this.pos];
      if (c === undefined) {
        if (term === null) return;
        fail('unterminated double quote');
      }
      if (c === term) {
        this.pos++;
        return;
      }
      if (c === '\\') {
        const n = s[this.pos + 1];
        if (n === undefined) fail('trailing backslash');
        if (n === '\n') this.pos += 2;
        else if (n === '$' || n === '`' || n === '\\' || (n === '"' && term === '"')) {
          w.value += n;
          this.pos += 2;
        } else {
          w.value += '\\';
          this.pos++;
        }
      } else if (c === '$') this.readDollar(w, true);
      else if (c === '`') this.readBacktick(w, true);
      else {
        w.value += c;
        this.pos++;
      }
    }
  }

  readDollar(w, inDQ) {
    const s = this.src;
    const p = this.pos;
    const n = s[p + 1];
    this.mark(w, false);
    if (n === "'" && !inDQ) {
      const r = decodeAnsiC(s, p + 2);
      w.value += r.str;
      w.quoted = true;
      this.pos = r.end;
      return;
    }
    if (n === '"' && !inDQ) {
      this.pos = p + 2;
      this.readDQ(w, '"');
      return;
    }
    if (n === '(') {
      if (s[p + 2] === '(') {
        const close = this.arithEnd(p);
        if (close >= 0) {
          this.readArith(w, p, close);
          return;
        }
      }
      this.subParse(p + 2);
      w.value += s.slice(p, this.pos);
      w.dynamic = true;
      return;
    }
    if (n === '{') {
      this.readParam(w, inDQ);
      return;
    }
    if (n === '[') fail('legacy $[ ] arithmetic is not supported');
    if (n !== undefined && /[A-Za-z_]/.test(n)) {
      let e = p + 2;
      while (/[A-Za-z0-9_]/.test(s[e] ?? '')) e++;
      w.value += s.slice(p, e);
      w.dynamic = true;
      this.pos = e;
    } else if (n !== undefined && /[0-9@*?$!#-]/.test(n)) {
      w.value += s.slice(p, p + 2);
      w.dynamic = true;
      this.pos = p + 2;
    } else {
      w.value += '$'; // a lone `$` is literal
      this.pos = p + 1;
    }
  }

  /** `${...}`: scan to the matching `}` so nested `$(...)` inside it is still parsed. */
  readParam(w, inDQ) {
    const s = this.src;
    const p = this.pos;
    this.pos = p + 2;
    const tmp = newBuilder();
    for (;;) {
      const c = s[this.pos];
      if (c === undefined) fail('unterminated ${');
      if (c === '}') {
        this.pos++;
        break;
      }
      if (c === '\\') {
        if (s[this.pos + 1] === undefined) fail('trailing backslash');
        this.pos += 2;
      } else if (c === "'" && !inDQ) {
        // Inside "${...}" a single quote is literal in bash; honouring it there would let
        // a `}` hide commands from us.
        const e = s.indexOf("'", this.pos + 1);
        if (e === -1) fail('unterminated single quote');
        this.pos = e + 1;
      } else if (c === '"') {
        this.pos++;
        this.readDQ(tmp, '"');
      } else if (c === '$') this.readDollar(tmp, inDQ);
      else if (c === '`') this.readBacktick(tmp, inDQ);
      else this.pos++;
    }
    const raw = s.slice(p, this.pos);
    // ${x@P} expands prompt escapes in the *value*, which can run command substitutions.
    if (/@P\}$/.test(raw)) fail('${...@P} prompt expansion is not supported');
    w.value += raw;
    w.dynamic = true;
  }

  /** Index of the first `)` of the closing `))` when `$((` at `p` is arithmetic, else -1. */
  arithEnd(p) {
    const s = this.src;
    let depth = 1;
    let i = p + 3;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === "'") {
        const e = s.indexOf("'", i + 1);
        if (e === -1) return -1;
        i = e + 1;
        continue;
      }
      if (c === '"') {
        i++;
        while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
        i++;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return s[i + 1] === ')' ? i : -1;
      }
      i++;
    }
    return -1;
  }

  readArith(w, p, close) {
    const body = this.src.slice(p + 3, close);
    // Single quotes inside arithmetic are not valid shell, and `$'..'` quoting there is the
    // classic way to make a paren scan disagree with the real parser.
    if (body.includes("'")) fail("single quote inside $(( ))");
    // Arithmetic can still contain $(cmd) and `cmd`, which run.
    const sub = this.child(body, 0);
    sub.readDQ(newBuilder(), null);
    this.adopt(sub);
    w.value += this.src.slice(p, close + 2);
    w.dynamic = true;
    this.pos = close + 2;
  }

  readBacktick(w, inDQ) {
    const s = this.src;
    const p = this.pos;
    let i = p + 1;
    let inner = '';
    for (;;) {
      const c = s[i];
      if (c === undefined) fail('unterminated backtick');
      if (c === '`') {
        i++;
        break;
      }
      if (c === '\\') {
        const n = s[i + 1];
        if (n === undefined) fail('trailing backslash');
        if (n === '`' || n === '$' || n === '\\' || (inDQ && n === '"')) {
          inner += n;
          i += 2;
          continue;
        }
      }
      inner += c;
      i++;
    }
    const sub = this.child(inner, 0);
    sub.parseList(new Set(), {});
    if (sub.heredocs.length) fail('unterminated heredoc');
    this.adopt(sub);
    this.mark(w, false);
    w.value += s.slice(p, i);
    w.dynamic = true;
    this.pos = i;
  }

  readProcSub(w) {
    const p = this.pos;
    this.subParse(p + 2);
    this.mark(w, false);
    w.value += this.src.slice(p, this.pos);
    w.dynamic = true;
  }

  /** Parse `...)` starting at `start` (just after the opener) in place and adopt its commands. */
  subParse(start) {
    const sub = this.child(this.src, start);
    sub.parseList(new Set([')']), {});
    const t = sub.take();
    if (t.t !== 'op' || t.v !== ')') fail('unterminated command substitution');
    if (sub.heredocs.length) fail('unterminated heredoc');
    this.adopt(sub);
    this.pos = sub.pos;
  }

  readHeredocBodies() {
    const s = this.src;
    for (const h of this.heredocs) {
      const lines = [];
      let found = false;
      while (this.pos < s.length) {
        const nl = s.indexOf('\n', this.pos);
        const end = nl === -1 ? s.length : nl;
        let line = s.slice(this.pos, end);
        this.pos = nl === -1 ? s.length : nl + 1;
        if (h.strip) line = line.replace(/^\t+/, '');
        if (line === h.delim) {
          found = true;
          break;
        }
        lines.push(line);
      }
      if (!found) fail(`unterminated heredoc (${h.delim})`);
      const body = lines.length ? `${lines.join('\n')}\n` : '';
      h.redirect.heredoc = body;
      if (!h.quoted && /[$`]/.test(body)) {
        h.redirect.heredocDynamic = true;
        // Unquoted heredoc bodies undergo expansion, so $(...) in them runs.
        const sub = this.child(body, 0);
        sub.readDQ(newBuilder(), null);
        this.adopt(sub);
      }
    }
    this.heredocs = [];
  }

  // ---- grammar --------------------------------------------------------------------------

  ctx() {
    return { pipeline: false, background: false, subshell: this.subshell > 0, substitution: this.substitution, negated: false };
  }

  markRange(start, key) {
    for (let i = start; i < this.out.length; i++) this.out[i].context[key] = true;
  }

  isStop(t, stops) {
    if (t.t === 'op') return stops.has(t.v);
    if (t.t === 'word' && t.bare && !t.assign) return stops.has(t.word.value);
    return false;
  }

  isReserved(t, name) {
    return t.t === 'word' && t.bare && !t.assign && t.word.value === name;
  }

  expectReserved(name) {
    if (!this.isReserved(this.peek(), name)) fail(`expected '${name}'`);
    this.take();
  }

  expectOp(v) {
    const t = this.peek();
    if (t.t !== 'op' || t.v !== v) fail(`expected '${v}'`);
    this.take();
  }

  /** Statements until EOF or a token in `stops` (left unconsumed). */
  parseList(stops, { nonEmpty = false } = {}) {
    let count = 0;
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      if (t.t === 'eof' || this.isStop(t, stops)) break;
      const start = this.parseAndOr();
      count++;
      const s = this.peek();
      if (s.t === 'nl') this.take();
      else if (s.t === 'op' && s.v === ';') this.take();
      else if (s.t === 'op' && s.v === '&') {
        this.take();
        this.markRange(start, 'background');
      } else if (s.t === 'eof' || (s.t === 'op' && stops.has(s.v))) break;
      else fail(`unexpected token after command`);
    }
    if (nonEmpty && count === 0) fail('empty command list');
  }

  parseAndOr() {
    const start = this.peek().idx;
    this.parsePipeline();
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && (t.v === '&&' || t.v === '||')) {
        this.take();
        this.skipNewlines();
        this.parsePipeline();
      } else break;
    }
    return start;
  }

  parsePipeline() {
    const start = this.peek().idx;
    let negated = false;
    let sawTime = false;
    for (;;) {
      const t = this.peek();
      if (this.isReserved(t, '!')) {
        negated = !negated;
        this.take();
      } else if (this.isReserved(t, 'time')) {
        sawTime = true;
        this.take();
        while (this.isReserved(this.peek(), '-p') || this.isReserved(this.peek(), '--')) this.take();
      } else break;
    }
    // A bare `time` with nothing after it is legal and runs nothing.
    const t0 = this.peek();
    const ends = t0.t === 'eof' || t0.t === 'nl' || (t0.t === 'op' && !this.isRedirTok(t0) && t0.v !== '(');
    if (sawTime && !negated && ends) return;
    this.parseCommand();
    let piped = false;
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && (t.v === '|' || t.v === '|&')) {
        this.take();
        this.skipNewlines();
        this.parseCommand();
        piped = true;
      } else break;
    }
    if (piped) this.markRange(start, 'pipeline');
    if (negated) this.markRange(start, 'negated');
  }

  isRedirTok(t) {
    return t.t === 'op' && REDIR_OPS.has(t.v);
  }

  startsCompound(t) {
    if (t.t === 'op') return t.v === '(';
    return t.t === 'word' && t.bare && !t.assign && COMPOUND_STARTS.has(t.word.value);
  }

  parseCommand() {
    const t = this.peek();
    if (t.t === 'op') {
      if (t.v === '(') return this.compound(() => this.parseSubshell());
      if (this.isRedirTok(t)) return this.parseSimple();
      return fail(`unexpected '${t.v}'`);
    }
    if (t.t !== 'word') return fail('missing command');
    if (t.bare && !t.assign) {
      const v = t.word.value;
      if (STRAY_RESERVED.has(v)) return fail(`unexpected '${v}'`);
      switch (v) {
        case 'if': return this.compound(() => this.parseIf());
        case 'while':
        case 'until': return this.compound(() => this.parseWhile());
        case 'for':
        case 'select': return this.compound(() => this.parseFor());
        case 'case': return this.compound(() => this.parseCase());
        case '{': return this.compound(() => this.parseGroup());
        case '[[': return this.compound(() => this.parseCond());
        case 'function': return this.parseFunction();
        case 'coproc': return this.parseCoproc();
        default:
      }
    }
    return this.parseSimple();
  }

  /** Run a compound parser, then attach trailing redirections to everything inside. */
  compound(fn) {
    const start = this.peek().idx;
    if (++this.depth > this.maxDepth) fail('nesting too deep');
    fn();
    this.depth--;
    const redirects = [];
    while (this.isRedirTok(this.peek())) this.parseRedirect(redirects);
    if (!redirects.length) return;
    // `{ a; b; } > f` redirects both a and b; make that visible on each command.
    const inner = this.out.slice(start).filter((c) => !this.adopted.has(c));
    if (inner.length === 0) {
      this.out.push({ argv: [], assignments: [], redirects, context: this.ctx() });
    } else {
      for (const c of inner) c.redirects.push(...redirects);
    }
  }

  parseSubshell() {
    if (this.take().dbl) fail('arithmetic command (( )) is not supported');
    this.subshell++;
    this.parseList(new Set([')']), { nonEmpty: true });
    this.expectOp(')');
    this.subshell--;
  }

  parseGroup() {
    this.take();
    this.subshell++;
    this.parseList(new Set(['}']), { nonEmpty: true });
    this.expectReserved('}');
    this.subshell--;
  }

  parseIf() {
    this.take();
    this.parseList(new Set(['then']), { nonEmpty: true });
    this.expectReserved('then');
    this.parseList(new Set(['elif', 'else', 'fi']), { nonEmpty: true });
    for (;;) {
      const t = this.peek();
      if (this.isReserved(t, 'elif')) {
        this.take();
        this.parseList(new Set(['then']), { nonEmpty: true });
        this.expectReserved('then');
        this.parseList(new Set(['elif', 'else', 'fi']), { nonEmpty: true });
      } else if (this.isReserved(t, 'else')) {
        this.take();
        this.parseList(new Set(['fi']), { nonEmpty: true });
        this.expectReserved('fi');
        return;
      } else if (this.isReserved(t, 'fi')) {
        this.take();
        return;
      } else fail("expected 'fi'");
    }
  }

  parseWhile() {
    this.take();
    this.parseList(new Set(['do']), { nonEmpty: true });
    this.expectReserved('do');
    this.parseList(new Set(['done']), { nonEmpty: true });
    this.expectReserved('done');
  }

  parseFor() {
    this.take();
    const nameTok = this.take();
    if (nameTok.t === 'op' && nameTok.v === '(') fail('arithmetic for loop is not supported');
    if (nameTok.t !== 'word' || !nameTok.bare || !NAME_RE.test(nameTok.word.value)) fail('invalid loop variable');
    this.skipNewlines();
    if (this.isReserved(this.peek(), 'in')) {
      this.take();
      for (;;) {
        const t = this.peek();
        if (t.t === 'word') this.take(); // loop items are data; substitutions in them were already collected
        else if (t.t === 'nl' || (t.t === 'op' && t.v === ';')) {
          this.take();
          break;
        } else fail('malformed for list');
      }
    } else if (this.peek().t === 'op' && this.peek().v === ';') this.take();
    this.skipNewlines();
    this.expectReserved('do');
    this.parseList(new Set(['done']), { nonEmpty: true });
    this.expectReserved('done');
  }

  parseCase() {
    this.take();
    const subject = this.take();
    if (subject.t !== 'word') fail('malformed case');
    this.skipNewlines();
    this.expectReserved('in');
    const stops = new Set([';;', ';&', ';;&', 'esac']);
    for (;;) {
      this.skipNewlines();
      if (this.isReserved(this.peek(), 'esac')) {
        this.take();
        return;
      }
      if (this.peek().t === 'op' && this.peek().v === '(') this.take();
      for (;;) {
        const p = this.take();
        if (p.t !== 'word') fail('malformed case pattern');
        const n = this.peek();
        if (n.t === 'op' && n.v === '|') this.take();
        else break;
      }
      this.expectOp(')');
      this.parseList(stops, {});
      const t = this.peek();
      if (t.t === 'op' && (t.v === ';;' || t.v === ';&' || t.v === ';;&')) this.take();
      else if (!this.isReserved(t, 'esac')) fail("expected ';;' or 'esac'");
    }
  }

  parseCond() {
    this.take();
    this.cond = true;
    for (;;) {
      const t = this.take();
      if (t.t === 'eof') fail("unterminated [[ ]]");
      if (this.isReserved(t, ']]')) break;
    }
    this.cond = false;
  }

  parseFunction() {
    this.take();
    const name = this.take();
    if (name.t !== 'word' || !name.bare) fail('invalid function name');
    if (this.peek().t === 'op' && this.peek().v === '(') {
      this.take();
      this.expectOp(')');
    }
    this.parseFunctionBody();
  }

  parseFunctionBody() {
    this.skipNewlines();
    if (!this.startsCompound(this.peek())) fail('function body must be a compound command');
    this.parseCommand();
  }

  parseCoproc() {
    this.take();
    const t = this.peek();
    if (this.startsCompound(t)) return this.parseCommand();
    if (t.t === 'word' && t.bare && !t.assign && NAME_RE.test(t.word.value)) {
      const first = this.take();
      if (this.startsCompound(this.peek())) return this.parseCommand(); // `coproc NAME { ...; }`
      this.buf.unshift(first); // it was the command word after all
    }
    return this.parseSimple();
  }

  parseRedirect(redirects) {
    const t = this.take();
    const target = this.peek();
    if (target.t !== 'word') fail(`missing redirection target after '${t.v}'`);
    this.take();
    const op = t.v === '<<-' ? '<<' : t.v;
    const r = { fd: t.fd, op, target: target.word };
    if (op === '<<') {
      r.heredoc = '';
      this.heredocs.push({ redirect: r, delim: target.word.value, strip: t.v === '<<-', quoted: target.word.quoted });
    }
    redirects.push(r);
  }

  parseSimple() {
    const argv = [];
    const assignments = [];
    const redirects = [];
    for (;;) {
      const t = this.peek();
      if (t.t === 'word') {
        this.take();
        if (!argv.length && t.assign) {
          assignments.push(t.assign);
          continue;
        }
        argv.push(t.word);
        if (argv.length === 1 && !assignments.length && !redirects.length && this.peek().t === 'op' && this.peek().v === '(') {
          // `name () compound` function definition: the body is what matters.
          if (!t.bare) fail('invalid function name');
          this.take();
          this.expectOp(')');
          this.parseFunctionBody();
          return;
        }
      } else if (this.isRedirTok(t)) {
        this.parseRedirect(redirects);
      } else break;
    }
    if (!argv.length && !assignments.length && !redirects.length) fail('missing command');
    this.out.push({ argv, assignments, redirects, context: this.ctx() });
  }
}

/**
 * Parse a shell command line without executing it.
 * @param {string} command
 * @param {{ maxLength?: number, maxDepth?: number }} [opts]
 * @returns {{ ok: true, commands: SimpleCommand[] } | { ok: false, reason: string }}
 */
export function parseShell(command, { maxLength = 100_000, maxDepth = 8 } = {}) {
  if (typeof command !== 'string') return { ok: false, reason: 'command is not a string' };
  if (command.length > maxLength) return { ok: false, reason: `command longer than ${maxLength} characters` };
  if (command.includes('\0')) return { ok: false, reason: 'command contains a NUL byte' };
  try {
    const p = new Parser(command, 0, { depth: 0, maxDepth, substitution: false });
    p.parseList(new Set(), {});
    if (p.peek().t !== 'eof') fail('unexpected trailing input');
    if (p.heredocs.length) fail('unterminated heredoc');
    return { ok: true, commands: p.out };
  } catch (err) {
    if (err instanceof ShellError) return { ok: false, reason: err.message };
    // RangeError (stack) or anything unforeseen: refusing is always the safe answer.
    return { ok: false, reason: `parser failure: ${err?.message ?? err}` };
  }
}

/** Command name without any directory: `/usr/bin/rm` -> `rm`. Escapes are already gone. */
export function basenameOf(word) {
  const v = typeof word === 'string' ? word : word.value;
  return v.slice(v.lastIndexOf('/') + 1);
}

// ---- wrapper unwrapping -----------------------------------------------------------------

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);

/**
 * Option tables for wrappers that take a command. Anything not listed makes the wrapper
 * "unresolved" (we cannot tell where the wrapped command starts), which fails closed.
 *  flag/arg/opt: short option characters without a value / with a value / with an attached
 *  optional value. lflag/larg: long options. noExec: seen options meaning nothing runs.
 */
const WRAPPERS = {
  env: { flag: 'i0v', arg: 'uCP', lflag: ['ignore-environment', 'null', 'debug'], larg: ['unset', 'chdir'], dash: true, assign: true },
  command: { flag: 'pvV', noExec: ['v', 'V'] },
  builtin: {},
  exec: { flag: 'cl', arg: 'a' },
  nohup: {},
  nice: { flag: '0123456789', arg: 'n', larg: ['adjustment'] },
  timeout: { flag: 'fpv', arg: 'sk', lflag: ['foreground', 'preserve-status', 'verbose'], larg: ['signal', 'kill-after'], positional: 1 },
  stdbuf: { arg: 'ioe', larg: ['input', 'output', 'error'] },
  sudo: {
    flag: 'AbEHnPSBiskKlvVe', arg: 'ughCDpRrtTU', assign: true,
    lflag: ['login', 'shell', 'non-interactive', 'preserve-env', 'set-home', 'stdin', 'background', 'reset-timestamp', 'remove-timestamp', 'list', 'validate', 'version', 'help', 'edit', 'askpass', 'bell'],
    larg: ['user', 'group', 'chdir', 'host', 'prompt', 'role', 'type', 'close-from', 'other-user', 'command-timeout', 'chroot'],
    noExec: ['l', 'v', 'V', 'K', 'e', 'list', 'validate', 'version', 'help', 'edit', 'remove-timestamp'],
  },
  doas: { flag: 'nsL', arg: 'uC' },
  time: { flag: 'apvlhq', arg: 'fo', lflag: ['append', 'portability', 'verbose', 'quiet'], larg: ['format', 'output'] },
  xargs: {
    flag: '0prtxovV', arg: 'ILnPsEdaJSR', opt: 'iel', fromStdin: true,
    lflag: ['null', 'no-run-if-empty', 'verbose', 'interactive', 'open-tty', 'exit', 'show-limits', 'replace', 'max-lines', 'eof', 'help', 'version'],
    larg: ['max-args', 'max-procs', 'max-chars', 'delimiter', 'arg-file', 'process-slot-var'],
  },
  watch: {
    flag: 'bcCegpqrtvwxzfh', arg: 'n', opt: 'd', shellString: true,
    lflag: ['differences', 'color', 'nocolor', 'beep', 'errexit', 'chgexit', 'precise', 'no-title', 'no-wrap', 'exec', 'help', 'version'],
    larg: ['interval', 'equexit'],
  },
  caffeinate: { flag: 'dimsu', arg: 'tw' },
  chronic: { flag: 'ev' },
  ionice: { flag: 't', arg: 'cnpPu', larg: ['class', 'classdata', 'pid', 'pgid', 'uid'], lflag: ['ignore'], noExec: ['p', 'P', 'u', 'pid', 'pgid', 'uid'] },
  setsid: { flag: 'cfw', lflag: ['ctty', 'fork', 'wait'] },
};

/** Walk leading options of a wrapper. Returns { i, seen } or null when it cannot be understood. */
function scanOptions(args, spec) {
  const flag = spec.flag ?? '';
  const arg = spec.arg ?? '';
  const opt = spec.opt ?? '';
  const lflag = spec.lflag ?? [];
  const larg = spec.larg ?? [];
  const seen = new Set();
  let i = 0;
  while (i < args.length) {
    const w = args[i];
    const v = w.value;
    if (v[0] !== '-' || v.length === 1) {
      if (v === '-' && spec.dash && !w.dynamic) {
        i++;
        continue;
      }
      break;
    }
    if (w.dynamic) return null;
    if (v === '--') {
      i++;
      break;
    }
    if (v.startsWith('--')) {
      const name = v.slice(2).split('=')[0];
      const hasValue = v.includes('=');
      if (larg.includes(name)) {
        i += hasValue ? 1 : 2;
      } else if (lflag.includes(name)) {
        i += 1;
      } else return null;
      seen.add(name);
      continue;
    }
    let consumed = 0;
    for (let k = 1; k < v.length; k++) {
      const ch = v[k];
      seen.add(ch);
      if (flag.includes(ch)) continue;
      if (arg.includes(ch)) {
        if (k === v.length - 1) consumed = 1;
        break;
      }
      if (opt.includes(ch)) break;
      return null;
    }
    i += 1 + consumed;
  }
  if (i > args.length) return null;
  return { i, seen };
}

function synth(value, base) {
  return {
    argv: [mkWord(value, { dynamic: true })],
    assignments: [],
    redirects: [],
    context: { ...base.context },
  };
}

/** Commands that will really run, with wrappers (env, sudo, sh -c, eval, find -exec...) removed. */
export function effectiveCommands(parsed) {
  const out = [];
  if (!parsed || !parsed.ok) {
    out.push(synth('<unparseable-shell>', { context: { pipeline: false, background: false, subshell: false, substitution: false, negated: false } }));
    return out;
  }
  for (const c of parsed.commands) unwrap(c, 0, out);
  return out;
}

function inner(cmd, argv, via, extra = {}) {
  return {
    argv,
    assignments: [...cmd.assignments, ...(extra.assignments ?? [])],
    redirects: [...cmd.redirects],
    context: { ...cmd.context, viaWrapper: cmd.context.viaWrapper ?? via, ...(extra.fromStdin ? { fromStdin: true } : {}) },
  };
}

function unwrap(cmd, depth, out) {
  if (depth > MAX_UNWRAP_DEPTH) {
    out.push(synth('<too-deep>', cmd));
    return;
  }
  const a0 = cmd.argv[0];
  if (!a0 || a0.dynamic) {
    out.push(cmd);
    return;
  }
  const name = basenameOf(a0);
  if (SHELLS.has(name)) return unwrapShell(cmd, name, depth, out);
  if (name === 'eval') return unwrapEval(cmd, depth, out);
  if (name === 'find') return unwrapFind(cmd, depth, out);
  if (Object.hasOwn(WRAPPERS, name)) return unwrapPrefix(cmd, name, WRAPPERS[name], depth, out);
  out.push(cmd);
}

/** Parse literal words as a script (eval semantics) and unwrap what comes out. */
function runString(cmd, words, via, depth, out, extra = {}) {
  if (words.some((w) => w.dynamic)) {
    out.push(synth('<dynamic-shell>', cmd));
    return;
  }
  const parsed = parseShell(words.map((w) => w.value).join(' '));
  if (!parsed.ok) {
    out.push(synth('<unparseable-shell>', cmd));
    return;
  }
  for (const c of parsed.commands) {
    const merged = {
      argv: c.argv,
      assignments: [...c.assignments, ...cmd.assignments],
      redirects: [...c.redirects, ...cmd.redirects],
      context: {
        pipeline: c.context.pipeline || cmd.context.pipeline,
        background: c.context.background || cmd.context.background,
        subshell: c.context.subshell || cmd.context.subshell,
        substitution: c.context.substitution || cmd.context.substitution,
        negated: c.context.negated !== cmd.context.negated,
        viaWrapper: cmd.context.viaWrapper ?? via,
        ...(cmd.context.fromStdin || extra.fromStdin ? { fromStdin: true } : {}),
      },
    };
    unwrap(merged, depth + 1, out);
  }
}

function unwrapPrefix(cmd, name, spec, depth, out) {
  const args = cmd.argv.slice(1);
  const scan = scanOptions(args, spec);
  if (!scan) {
    out.push(cmd, synth('<unresolved-wrapper>', cmd));
    return;
  }
  let { i } = scan;
  const noExec = (spec.noExec ?? []).some((o) => scan.seen.has(o));
  i += spec.positional ?? 0;
  const assignments = [];
  if (spec.assign) {
    while (i < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i].value)) {
      const w = args[i];
      const eq = w.value.indexOf('=');
      assignments.push({ name: w.value.slice(0, eq), value: mkWord(w.value.slice(eq + 1), w) });
      i++;
    }
  }
  const rest = args.slice(i);
  if (noExec || rest.length === 0) {
    out.push(cmd); // nothing is wrapped; the policy judges the wrapper itself
    return;
  }
  if (spec.shellString && !scan.seen.has('x') && !scan.seen.has('exec')) {
    // watch hands its arguments to `sh -c`.
    runString(inner(cmd, [], name), rest, name, depth, out);
    return;
  }
  unwrap(inner(cmd, rest, name, { assignments, fromStdin: spec.fromStdin }), depth + 1, out);
}

function unwrapShell(cmd, name, depth, out) {
  const args = cmd.argv.slice(1);
  let i = 0;
  let cFlag = false;
  let sFlag = false;
  while (i < args.length && !cFlag) {
    const w = args[i];
    const v = w.value;
    if (v === '--') {
      i++;
      break;
    }
    if ((v[0] === '-' || v[0] === '+') && v.length > 1) {
      if (w.dynamic) {
        out.push(synth('<dynamic-shell>', cmd));
        return;
      }
      if (v.startsWith('--')) {
        i += v === '--rcfile' || v === '--init-file' ? 2 : 1;
        continue;
      }
      let consumes = 0;
      for (const ch of v.slice(1)) {
        if (ch === 'c' && v[0] === '-') cFlag = true;
        if (ch === 's' && v[0] === '-') sFlag = true;
        if (ch === 'o' || ch === 'O') consumes++;
      }
      i += 1 + consumes;
      continue;
    }
    break;
  }
  if (cFlag) {
    if (i >= args.length) {
      out.push(cmd);
      return;
    }
    runString(cmd, [args[i]], name, depth, out);
    return;
  }
  // `sh script.sh` / `sh` reading stdin: the shell itself is what the policy must judge...
  out.push(cmd);
  if (i < args.length && !sFlag) return;
  // ...and when stdin is a heredoc or here-string we can also see the script.
  for (const r of cmd.redirects) {
    if (r.fd !== null && r.fd !== 0) continue;
    if (r.op === '<<') {
      if (r.heredocDynamic) out.push(synth('<dynamic-shell>', cmd));
      else runString(cmd, [mkWord(r.heredoc ?? '')], name, depth, out, { fromStdin: true });
    } else if (r.op === '<<<') {
      runString(cmd, [r.target], name, depth, out, { fromStdin: true });
    }
  }
}

function unwrapEval(cmd, depth, out) {
  let args = cmd.argv.slice(1);
  if (args[0] && !args[0].dynamic && args[0].value === '--') args = args.slice(1);
  if (args.length === 0) {
    out.push(cmd);
    return;
  }
  runString(cmd, args, 'eval', depth, out);
}

const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);

function unwrapFind(cmd, depth, out) {
  out.push(cmd); // find itself (-delete, -fprint...) is still judged by the policy
  const args = cmd.argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    // An unquoted expansion can word-split into extra primaries such as `-exec`.
    if (w.dynamic && !w.quoted) {
      out.push(synth('<unresolved-wrapper>', cmd));
      return;
    }
    if (w.dynamic || !FIND_EXEC.has(w.value)) continue;
    const body = [];
    let j = i + 1;
    while (j < args.length && !(args[j].value === ';' || args[j].value === '+') ) body.push(args[j++]);
    if (j >= args.length || body.length === 0) {
      out.push(synth('<unresolved-wrapper>', cmd));
      return;
    }
    unwrap(inner(cmd, body, 'find'), depth + 1, out);
    i = j;
  }
}
