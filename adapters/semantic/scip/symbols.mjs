// SCIP symbol strings: `<scheme> <manager> <package> <version> <descriptor>+`, or `local <id>`.
// A descriptor is a name plus a suffix: `/` namespace, `#` type, `.` term (field, property,
// variable), `(<disambiguator>).` method, `[name]` type parameter, `(name)` parameter, `:` meta,
// `!` macro. Names with other characters are wrapped in backticks. Space in a package part is
// written as two spaces.

const NAME = /[\w$+\-]+/y;

/** The descriptors of a global symbol as `[{ name, suffix }]`, or null for a local or malformed one. */
export function descriptors(symbol) {
  if (symbol.startsWith('local ')) return null;
  let i = 0;
  for (let part = 0; part < 4; part++) {
    for (;;) {
      if (i >= symbol.length) return null;
      if (symbol[i] === ' ') {
        if (symbol[i + 1] === ' ') i += 2;
        else break;
      } else i++;
    }
    i++;
  }
  const out = [];
  while (i < symbol.length) {
    const c = symbol[i];
    if (c === '[' || (c === '(' && !out.length)) {
      const close = symbol.indexOf(c === '[' ? ']' : ')', i);
      if (close < 0) return null;
      out.push({ name: symbol.slice(i + 1, close), suffix: c === '[' ? 'typeparam' : 'param' });
      i = close + 1;
      continue;
    }
    if (c === '(') {
      const close = symbol.indexOf(')', i);
      if (close < 0) return null;
      out.push({ name: symbol.slice(i + 1, close), suffix: 'param' });
      i = close + 1;
      continue;
    }
    let name;
    if (c === '`') {
      let j = i + 1;
      name = '';
      for (;;) {
        if (j >= symbol.length) return null;
        if (symbol[j] === '`') {
          if (symbol[j + 1] === '`') {
            name += '`';
            j += 2;
          } else break;
        } else name += symbol[j++];
      }
      i = j + 1;
    } else {
      NAME.lastIndex = i;
      const m = NAME.exec(symbol);
      if (!m) return null;
      name = m[0];
      i += name.length;
    }
    const s = symbol[i++];
    if (s === '/') out.push({ name, suffix: 'namespace' });
    else if (s === '#') out.push({ name, suffix: 'type' });
    else if (s === '.') out.push({ name, suffix: 'term' });
    else if (s === ':') out.push({ name, suffix: 'meta' });
    else if (s === '!') out.push({ name, suffix: 'macro' });
    else if (s === '(') {
      const close = symbol.indexOf(')', i);
      if (close < 0 || symbol[close + 1] !== '.') return null;
      out.push({ name, suffix: 'method' });
      i = close + 2;
    } else return null;
  }
  return out;
}

/**
 * What a symbol is, for the facts Unknot keeps: `type` (class, interface, struct, enum...),
 * `member` (a field, property or other term inside a type), `method` (inside a type or free
 * function), or null for namespaces, parameters, type parameters, locals and anything unparsed.
 * `name` is the last descriptor's name; `owner` the enclosing type's name for a member.
 */
export function classify(symbol) {
  const d = descriptors(symbol);
  if (!d?.length) return null;
  const last = d[d.length - 1];
  const parent = d.length > 1 ? d[d.length - 2] : null;
  if (last.suffix === 'type') return { kind: 'type', name: last.name, owner: parent?.suffix === 'type' ? parent.name : null };
  if (last.suffix === 'method') return { kind: 'method', name: last.name, owner: parent?.suffix === 'type' ? parent.name : null };
  if (last.suffix === 'term' && parent?.suffix === 'type') return { kind: 'member', name: last.name, owner: parent.name };
  return null;
}
