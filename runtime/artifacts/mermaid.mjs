// Text safety for generated diagrams and pages. Everything that reaches a Mermaid or
// Structurizr document from the repository (names, paths, tags) is untrusted: a crafted
// module name must not be able to open a directive (`%%{init}`), attach a click/href
// callback, smuggle a `javascript:` URL, or break out of a quoted label.

const FORBIDDEN = /%%|javascript:|\bclick\b|\bhref\b/gi;
// Quotes and brackets close labels; `;` ends a statement in sequence diagrams; `#` starts
// an entity code; `<`/`>` become HTML in some renderers; backslash escapes; `,` splits
// C4 arguments.
const STRUCTURAL = /["'`\\<>[\]{}()|;#&$,]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * A label that is safe inside a double-quoted Mermaid, C4 or DSL string and inside a
 * markdown line. Lossy by design.
 * @param {unknown} text
 * @param {number} [max]
 */
export function plain(text, max = 80) {
  let s = String(text ?? '').replace(CONTROL, ' ').replace(STRUCTURAL, ' ');
  // Removal could splice a forbidden word back together; loop so the guarantee does not
  // rest on the argument that the spaces we insert always separate it.
  let prev;
  do {
    prev = s;
    s = s.replace(FORBIDDEN, ' ');
  } while (s !== prev);
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = `${s.slice(0, Math.max(1, max - 3)).trimEnd()}...`;
  return s || '-';
}

/** Stable, repository-independent identifiers: `n1`, `n2`... never derived from text. */
export class IdMap {
  constructor(prefix = 'n') {
    this.prefix = prefix;
    this.map = new Map();
  }

  get(key) {
    let id = this.map.get(key);
    if (!id) this.map.set(key, (id = `${this.prefix}${this.map.size + 1}`));
    return id;
  }

  has(key) {
    return this.map.has(key);
  }
}

/** A fenced mermaid block that its content cannot terminate early. */
export function mermaidFence(source) {
  return `\`\`\`mermaid\n${String(source).replace(/```/g, "'''")}\n\`\`\``;
}
