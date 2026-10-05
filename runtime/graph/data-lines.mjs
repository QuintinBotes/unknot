// Line-based detection of "pure data" lines: translation tables, seed data, mock scenarios.
// A data line holds only literals, object keys with literal/array/object values, and the
// brackets that open or close such literals. It is deliberately conservative: any call,
// operator other than `:` and `,`, identifier that is not a key or a literal keyword, or
// statement keyword makes the line code. A closing bracket counts only when it closes a
// bracket that a data line opened, so the end of an `if` block is never data.

const TOKEN = new RegExp(
  '\\s*(?:'
  + '(\'(?:[^\'\\\\]|\\\\.)*\'|"(?:[^"\\\\]|\\\\.)*"|`[^`$\\\\]*`)' // 1 string
  + '|(-?(?:0[xXbBoO][\\da-fA-F_]+|\\d[\\d_]*\\.?\\d*(?:[eE][+-]?\\d+)?|\\.\\d+)n?)' // 2 number
  + '|((?:true|false|null|undefined|None|True|False)\\b(?!\\s*[(.\\w]))' // 3 literal keyword
  + '|([A-Za-z_$][\\w$]*)(?=\\s*:(?!:))' // 4 bare key
  + '|([\\[\\]{},:]))', // 5 punctuation
  'y',
);

/** Tokens of a data-shaped line ('v' for a value or key, else the punctuation), or null if the line is code. */
function dataTokens(line, comment) {
  const out = [];
  let pos = 0;
  for (;;) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(line);
    if (!m) break;
    pos = TOKEN.lastIndex;
    out.push(m[5] !== undefined ? m[5] : 'v');
  }
  let rest = line.slice(pos).trim();
  if (rest.startsWith(';')) rest = rest.slice(1).trim();
  if (rest && !rest.startsWith(comment)) return null;
  // `default:` or a label alone has no value.
  return out.length && out[out.length - 1] !== ':' ? out : null;
}

/** Brackets in a code line, ignoring strings and a trailing comment. */
function codeBrackets(line, comment) {
  const s = line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`/g, '""');
  const ci = s.indexOf(comment);
  return (ci >= 0 ? s.slice(0, ci) : s).match(/[[\]{}()]/g) ?? [];
}

/**
 * @param {string} text
 * @param {'js'|'py'} lang
 * @returns {Int32Array} prefix[n] = data lines among the first n lines (1-based)
 */
export function dataLinePrefix(text, lang = 'js') {
  const comment = lang === 'py' ? '#' : '//';
  const lines = String(text ?? '').split(/\r\n|\r|\n/);
  const prefix = new Int32Array(lines.length + 1);
  const stack = [];
  let prev = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    let data = false;
    if (line && !line.startsWith(comment) && !line.startsWith('/*') && !line.startsWith('*')) {
      const toks = dataTokens(line, comment);
      if (toks) {
        data = true;
        // A lone opener is data only when it plainly starts a literal.
        if (toks.length === 1 && (toks[0] === '{' || toks[0] === '[') && !(stack[stack.length - 1] === 'data' || /[=:,[({]$/.test(prev))) data = false;
        const opened = [];
        for (const t of toks) {
          if (t === '{' || t === '[') opened.push('data');
          else if (t === '}' || t === ']') {
            const top = opened.length ? opened.pop() : stack.pop();
            if (top !== 'data') data = false;
          }
        }
        stack.push(...opened.map(() => (data ? 'data' : 'code')));
      } else {
        for (const b of codeBrackets(line, comment)) {
          if (b === '{' || b === '[' || b === '(') stack.push('code');
          else stack.pop();
        }
      }
      prev = line;
    }
    if (stack.length > 256) stack.splice(0, stack.length - 256);
    prefix[i + 1] = prefix[i] + (data ? 1 : 0);
  }
  return prefix;
}

/** Data lines within the 1-based inclusive range [start, end]. */
export function dataLinesIn(prefix, start, end) {
  const s = Math.max(1, start | 0);
  const e = Math.min(prefix.length - 1, end | 0);
  return e < s ? 0 : prefix[e] - prefix[s - 1];
}
