// Local (code-level) detectors: size, complexity, nesting, parameters, dead code, needless
// indirection and clones. Each reads only the graph, never the filesystem, and proposes a
// FindingDraft (runtime/diagnose/README.md). Thresholds are plain defaults overridable
// through config.detectors['local.<name>']; every threshold in effect is echoed back in the
// draft so a reviewer can see what the claim rests on, and heuristic ones say so.

const SOURCE_NODE_TYPES = ['function', 'method'];

/** Option lookup: a configured number wins, anything else falls back to the default. */
export function opt(options, key, dflt) {
  const v = options?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Evidence quality: 0.9 for parser-derived facts, 0.6 when the module was read lexically. */
export function evidenceFor(attrs) {
  return attrs?.parse_quality === 'lexical' || attrs?.parse_quality === 'syntax_error' ? 0.6 : 0.9;
}

/** The module node that owns a symbol or file-level node. */
export function moduleOf(graph, node) {
  if (node.type === 'module') return node;
  if (node.path) {
    const m = graph.node(`module:${node.path}`);
    if (m) return m;
  }
  const parent = graph.parent(node.id);
  return parent && parent.type === 'module' ? parent : (parent ? moduleOf(graph, parent) : null);
}

export function isTestModule(mod) {
  return !mod || mod.attrs?.is_test === true;
}

/** Inbound TESTS edges on a node and (for symbols) its module: the `tests.present` signal. */
export function testsPresent(graph, node) {
  let n = graph.in(node.id, 'TESTS').length;
  if (node.type !== 'module') {
    const m = moduleOf(graph, node);
    if (m) n += graph.in(m.id, 'TESTS').length;
  }
  return n;
}

const srcRef = (node) => (node.path ? `${node.path}:${node.attrs?.start_line ?? 1}` : null);
const fileScope = (node) => (node.path ? [node.path] : []);
const nameOf = (node) => String(node.name ?? node.id).split('#').pop();

function verificationFor(tests, extra = []) {
  const first = tests === 0
    ? ['No tests cover this scope: write characterization tests that pin current behaviour before changing anything.']
    : [`Run the ${tests} covering test(s) before and after the change; results must match.`];
  return [...first, ...extra, 'Run the project type check and linter over the touched files.'];
}

/** Fields every local draft shares; detectors layer their specifics on top. */
function base(graph, node, { kind, title, summary, measurements, thresholds, benefit, cost, evidence, uncertain = 1, tests }) {
  const mod = moduleOf(graph, node);
  const t = tests ?? testsPresent(graph, node);
  const isPrivate = node.attrs?.exported === false;
  return {
    kind,
    title,
    scope: fileScope(node),
    key: node.id,
    evidence: [{ ref: node.id, label: 'observed', summary, source_ref: srcRef(node) }],
    measurements: { 'tests.present': t, ...measurements },
    thresholds,
    quality_impacts: { changeability: 'medium', reliability: 'low', security: 'low' },
    blast_radius: 'local',
    factors: { benefit: clamp(Math.round(benefit), 1, 5), evidence: evidence ?? evidenceFor(mod?.attrs ?? node.attrs), reversibility: 0.9, blast: 1, cost: clamp(Math.round(cost), 1, 5), uncertainty: uncertain },
    invariants: [
      'Observable behaviour (return values, side effects, thrown errors) is unchanged.',
      isPrivate ? 'The symbol is private, so callers inside its own module are the only compatibility surface.' : 'The public signature and import path are unchanged.',
    ],
    recovery: { type: 'revert', notes: 'A single reviewable commit; reverting restores the previous structure exactly.' },
    verification: verificationFor(t),
    uncertainties: parseUncertainty(mod?.attrs),
  };
}

function parseUncertainty(attrs) {
  if (attrs?.parse_quality === 'lexical') return ['The module was read lexically (no full parser), so metrics are approximate and confidence is low.'];
  if (attrs?.parse_quality === 'syntax_error') return ['The module has a syntax error; metrics may be incomplete.'];
  return [];
}

/** Functions and methods outside test modules, in stable id order. */
function* codeSymbols(graph, types = SOURCE_NODE_TYPES) {
  for (const type of types) {
    for (const node of [...graph.nodes(type)].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (node.attrs?.is_test === true || isTestModule(moduleOf(graph, node))) continue;
      yield node;
    }
  }
}

/** Define a detector from a name and a run function; id/category/version are uniform. */
function define({ name, kinds, defaults = {}, run }) {
  return {
    id: `local.${name}`,
    version: '1.0.0',
    category: 'local',
    kinds,
    detect(ctx) {
      const options = {};
      for (const [k, v] of Object.entries(defaults)) options[k] = opt(ctx.options, k, v);
      return run(ctx.graph, options, ctx.options ?? {});
    },
  };
}

const symbolKind = (node) => (node.type === 'method' ? 'method' : 'function');

// ---------------------------------------------------------------------------------------
// Function-level size and complexity
// ---------------------------------------------------------------------------------------

const longFunction = define({
  name: 'long-function',
  kinds: ['code.long-function'],
  // UI components are measured against their own threshold: JSX markup is lines without
  // branching (dogfood round 2: 269 of 545 findings on one TSX app were components).
  defaults: { lines: 80, component_lines: 150 },
  run(graph, o) {
    const out = [];
    for (const n of codeSymbols(graph)) {
      const lines = n.attrs.lines ?? 0;
      const component = /\.(jsx|tsx|vue|svelte)$/.test(n.path ?? '') && /^[A-Z]/.test(nameOf(n).split('.').pop());
      const limit = component ? o.component_lines : o.lines;
      if (lines <= limit) continue;
      const d = base(graph, n, {
        kind: 'code.long-function',
        title: `${component ? 'Component ' : ''}${nameOf(n)} is ${lines} lines long (threshold ${limit})`,
        summary: `${lines} lines, cyclomatic ${n.attrs.cyclomatic ?? '?'}, max nesting ${n.attrs.max_nesting ?? '?'}`,
        measurements: { 'function.lines': lines, ...(n.attrs.cyclomatic != null && { 'function.cyclomatic': n.attrs.cyclomatic }) },
        thresholds: { lines: limit, 'lines.note': 'heuristic: a readability guideline, not a defect limit' },
        benefit: 1 + lines / 80,
        cost: lines > 300 ? 4 : lines > 150 ? 3 : 2,
      });
      out.push({
        ...d,
        why_accidental: `A ${symbolKind(n)} of ${lines} lines mixes several steps that each need to be understood, tested and changed together.`,
        essential_considerations: ['A long linear sequence (a parser table, a declarative mapping) can be clearer unbroken than split into arbitrary pieces.'],
        smallest_simplification: `Extract the single most self-contained block of ${nameOf(n)} into a named function and call it; stop after one extraction and re-measure.`,
        risks: ['Extraction can change variable capture or evaluation order if blocks share mutable locals.'],
        alternatives: [
          { id: 'retain', summary: 'Keep it whole if the steps are strictly sequential and splitting would force passing many shared locals between pieces.' },
          { id: 'extract-functions', summary: 'Extract cohesive blocks into named helpers, one at a time.' },
          { id: 'guard-clauses', summary: 'Flatten leading validation into early returns to shorten the main path first.' },
        ],
        patterns: ['code.extract-function', 'code.guard-clauses'],
      });
    }
    return out;
  },
});

const complexFunction = define({
  name: 'complex-function',
  kinds: ['code.complex-function'],
  defaults: { cyclomatic: 15, cognitive: 20 },
  run(graph, o) {
    const out = [];
    for (const n of codeSymbols(graph)) {
      const cy = n.attrs.cyclomatic;
      const cg = n.attrs.cognitive;
      const overCy = typeof cy === 'number' && cy > o.cyclomatic;
      const overCg = typeof cg === 'number' && cg > o.cognitive;
      if (!overCy && !overCg) continue;
      const parts = [];
      if (overCy) parts.push(`cyclomatic ${cy} (threshold ${o.cyclomatic})`);
      if (overCg) parts.push(`cognitive ${cg} (threshold ${o.cognitive})`);
      const worst = Math.max(overCy ? cy / o.cyclomatic : 0, overCg ? cg / o.cognitive : 0);
      const d = base(graph, n, {
        kind: 'code.complex-function',
        title: `${nameOf(n)} is too complex: ${parts.join(', ')}`,
        summary: `cyclomatic ${cy ?? '?'}, cognitive ${cg ?? '?'}, ${n.attrs.lines ?? '?'} lines`,
        measurements: { ...(cy != null && { 'function.cyclomatic': cy }), ...(cg != null && { 'function.cognitive': cg }), ...(n.attrs.lines != null && { 'function.lines': n.attrs.lines }) },
        thresholds: { cyclomatic: o.cyclomatic, cognitive: o.cognitive, note: 'heuristic: widely used defaults, tune per codebase' },
        benefit: 1 + worst * 1.5,
        cost: worst > 2 ? 4 : 3,
      });
      out.push({
        ...d,
        why_accidental: 'Many independent branches in one body multiply the paths a reader and a test suite must cover.',
        essential_considerations: ['Some branching mirrors genuinely distinct business rules (tax, eligibility); those branches should stay, in a more legible shape.'],
        smallest_simplification: `Pull the deepest or most repeated branch of ${nameOf(n)} into a named function, or replace one type-switch with a lookup table; re-measure.`,
        risks: ['Branch reordering can alter short-circuit semantics.', 'Tests that exercise only the happy path will not notice a lost branch.'],
        alternatives: [
          { id: 'retain', summary: 'Keep it when the branches enumerate a closed, stable set of rules that reads best in one place.' },
          { id: 'extract-functions', summary: 'Extract branch bodies into named helpers.' },
          { id: 'polymorphism', summary: 'Replace a type-code conditional with polymorphic dispatch if the same switch recurs elsewhere.' },
        ],
        patterns: ['code.extract-function', 'code.guard-clauses', 'code.replace-conditional-with-polymorphism'],
      });
    }
    return out;
  },
});

const deepNesting = define({
  name: 'deep-nesting',
  kinds: ['code.deep-nesting'],
  defaults: { max_nesting: 4 },
  run(graph, o) {
    const out = [];
    for (const n of codeSymbols(graph)) {
      const depth = n.attrs.max_nesting;
      if (typeof depth !== 'number' || depth <= o.max_nesting) continue;
      const d = base(graph, n, {
        kind: 'code.deep-nesting',
        title: `${nameOf(n)} nests ${depth} levels deep (threshold ${o.max_nesting})`,
        summary: `max nesting ${depth}, cyclomatic ${n.attrs.cyclomatic ?? '?'}`,
        measurements: { 'function.max_nesting': depth, ...(n.attrs.cyclomatic != null && { 'function.cyclomatic': n.attrs.cyclomatic }) },
        thresholds: { max_nesting: o.max_nesting, note: 'heuristic: indentation depth correlates with, but does not prove, hard-to-follow control flow' },
        benefit: 1 + (depth - o.max_nesting) * 0.8,
        cost: 2,
      });
      out.push({
        ...d,
        why_accidental: 'Each level of nesting adds a condition the reader must hold in mind; most of it is validation that could return early.',
        essential_considerations: ['Nested loops over genuinely multi-dimensional data are inherent to the problem.'],
        smallest_simplification: `Invert the outermost condition of ${nameOf(n)} into a guard clause (early return or continue) and re-measure nesting.`,
        risks: ['Early returns skip cleanup code placed after the nested block.'],
        alternatives: [
          { id: 'retain', summary: 'Keep it if the nesting reflects a multi-dimensional traversal that flattening would obscure.' },
          { id: 'guard-clauses', summary: 'Replace nested conditions with guard clauses.' },
          { id: 'extract-functions', summary: 'Move the inner block into a named function.' },
        ],
        patterns: ['code.guard-clauses', 'code.extract-function'],
      });
    }
    return out;
  },
});

const longParameterList = define({
  name: 'long-parameter-list',
  kinds: ['code.long-parameter-list'],
  // 6, not 5: idiomatic framework handlers (FastAPI dependencies, Express (req, res, next))
  // routinely take several injected parameters. Endpoint handlers are skipped below.
  defaults: { params: 6 },
  run(graph, o) {
    const out = [];
    for (const n of codeSymbols(graph)) {
      // Count what callers must get right: required parameters when the adapter knows
      // them (optional keyword-only parameters cannot be passed in the wrong order), but
      // still flag very long lists outright (dogfood FB14).
      const total = n.attrs.params;
      const required = Number.isInteger(n.attrs.params_required) ? n.attrs.params_required : total;
      if (typeof total !== 'number' || (required <= o.params && total < 2 * o.params + 1)) continue;
      const p = required > o.params ? required : total;
      if (graph.out(n.id, 'EXPOSES').length || (n.attrs.decorators ?? []).some((d) => /route|get|post|put|patch|delete|api|endpoint|task|command/i.test(d))) continue; // framework entry point: parameters are injected
      const d = base(graph, n, {
        kind: 'code.long-parameter-list',
        title: required > o.params ? `${nameOf(n)} takes ${p} ${p === total ? '' : 'required '}parameters (threshold ${o.params})` : `${nameOf(n)} takes ${total} parameters, ${required} required (threshold ${o.params}; very long lists are flagged regardless)`,
        summary: `${p} parameters${Array.isArray(n.attrs.param_names) ? `: ${n.attrs.param_names.slice(0, 8).join(', ')}` : ''}`,
        measurements: { 'function.params': p },
        thresholds: { params: o.params, note: 'heuristic: argument-order mistakes grow with arity, but the limit is a convention' },
        benefit: 1 + (p - o.params) * 0.5,
        cost: 2 + (n.attrs.exported === false ? 0 : 1),
      });
      out.push({
        ...d,
        why_accidental: 'Callers must remember an argument order and pass values that usually travel together.',
        essential_considerations: ['A framework-mandated signature (callback, handler, override) cannot be changed.'],
        smallest_simplification: `Group the parameters of ${nameOf(n)} that always travel together into one parameter object and migrate the callers.`,
        risks: ['Every caller changes; exported functions need a compatibility shim or a coordinated release.'],
        alternatives: [
          { id: 'retain', summary: 'Keep the signature when it is dictated by a framework or a stable public API.' },
          { id: 'parameter-object', summary: 'Introduce a parameter object for the related arguments.' },
        ],
        patterns: ['code.introduce-parameter-object'],
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------------------
// Class and module size
// ---------------------------------------------------------------------------------------

const methodCount = (graph, c) => c.attrs.methods ?? graph.children(c.id, 'method').length;

const largeClass = define({
  name: 'large-class',
  kinds: ['code.large-class'],
  defaults: { methods: 20, lines: 500 },
  run(graph, o) {
    const out = [];
    for (const c of codeSymbols(graph, ['class'])) {
      const methods = methodCount(graph, c);
      const lines = c.attrs.lines ?? 0;
      if (methods <= o.methods && lines <= o.lines) continue;
      const d = base(graph, c, {
        kind: 'code.large-class',
        title: `${nameOf(c)} has ${methods} methods over ${lines} lines (thresholds ${o.methods} methods, ${o.lines} lines)`,
        summary: `${methods} methods, ${lines} lines`,
        measurements: { 'class.methods': methods, 'class.lines': lines },
        thresholds: { methods: o.methods, lines: o.lines, note: 'heuristic: size proxies for multiple responsibilities' },
        benefit: 2 + Math.max(methods / o.methods, lines / o.lines),
        cost: 4,
        uncertain: 2,
      });
      out.push({
        ...d,
        why_accidental: 'A class this size usually accumulates several responsibilities that change for different reasons.',
        essential_considerations: ['A facade or aggregate root may legitimately expose many methods over a small core.'],
        smallest_simplification: `Move the group of ${nameOf(c)} methods that share the same fields into a new collaborator class and delegate to it.`,
        risks: ['Hidden coupling through shared mutable fields; subclasses overriding moved methods.'],
        alternatives: [
          { id: 'retain', summary: 'Keep it when the class is a deliberate facade or its methods are thin delegations over one cohesive state.' },
          { id: 'extract-class', summary: 'Split one cohesive responsibility into its own class.' },
        ],
        patterns: ['anti-pattern.god-object', 'code.extract-function'],
      });
    }
    return out;
  },
});

const largeModule = define({
  name: 'large-module',
  kinds: ['code.large-module'],
  defaults: { sloc: 1000 },
  run(graph, o) {
    const out = [];
    for (const m of [...graph.nodes('module')].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (isTestModule(m)) continue;
      const sloc = m.attrs.sloc ?? 0;
      if (sloc <= o.sloc) continue;
      const d = base(graph, m, {
        kind: 'code.large-module',
        title: `${m.path ?? m.name} has ${sloc} source lines (threshold ${o.sloc})`,
        summary: `${sloc} source lines of ${m.attrs.loc ?? '?'} total`,
        measurements: { 'module.loc': m.attrs.loc ?? sloc },
        thresholds: { sloc: o.sloc, note: 'heuristic: file length is a convention, not a defect' },
        benefit: 2 + sloc / o.sloc,
        cost: 4,
        uncertain: 2,
      });
      out.push({
        ...d,
        why_accidental: 'Unrelated concerns share one file, so unrelated changes collide and the file resists navigation.',
        essential_considerations: ['Generated-like tables or a single cohesive state machine can be long and still coherent.'],
        smallest_simplification: `Move the most self-contained group of definitions in ${m.path ?? m.name} to a sibling module and re-export it from the original.`,
        risks: ['Import cycles introduced by the split.', 'Public import paths change unless the original re-exports.'],
        alternatives: [
          { id: 'retain', summary: 'Keep the file when its contents are one cohesive unit that is always read together.' },
          { id: 'split-module', summary: 'Split by responsibility, keeping the original path as a facade.' },
        ],
        patterns: ['anti-pattern.god-object', 'domain.module-facade'],
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------------------
// Dead code
// ---------------------------------------------------------------------------------------

const ENTRY_BASENAMES = new Set(['index', 'main', 'app', 'server', 'cli', '__main__', 'manage', '__init__', 'setup', 'conftest', 'wsgi', 'asgi', 'settings']);
const CONFIG_RE = /(^|\/)(\.?[\w-]*\.config|[\w-]+\.conf|(jest|vite|vitest|webpack|rollup|babel|eslint|prettier|tailwind|postcss|next|nuxt|svelte|astro|tsup|karma|gulpfile|gruntfile|Makefile|noxfile|tox|setup)[\w.-]*)\.(c?m?[jt]s|json|ya?ml|toml|py|rb|cfg)$/i;
const ROUTE_DIR_RE = /(^|\/)(routes?|pages?|app|views|handlers|controllers|api|endpoints|commands|migrations|management)\//;
const ROUTE_FILE_RE = /(^|\/)(page|route|layout|loading|error|not-found|\+page|\+server|\+layout)\.[a-z]+$/;

const baseName = (p) => p.split('/').pop().replace(/\.[^.]+$/, '');

function collectStrings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => collectStrings(x, out));
  return out;
}

/** Paths declared as entry points by package manifests (main, bin, exports, ...). */
function declaredEntries(graph) {
  const entries = new Set();
  for (const p of graph.nodes('package')) {
    const dir = p.attrs?.dir && p.attrs.dir !== '.' ? p.attrs.dir : (p.path?.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : '');
    for (const key of ['main', 'module', 'bin', 'exports', 'types', 'entry', 'entrypoints', 'entry_points']) {
      for (const s of collectStrings(p.attrs?.[key])) {
        const rel = s.replace(/^\.\//, '');
        entries.add(dir ? `${dir}/${rel}` : rel);
      }
    }
  }
  return entries;
}

/** Why a module is exempt from the unreferenced-module check, or null when it is not. */
function moduleEntryReason(graph, m, entries) {
  const path = m.path ?? '';
  if (ENTRY_BASENAMES.has(baseName(path))) return 'entry-point name';
  if (entries.has(path) || [...entries].some((e) => e.replace(/\.[^./]+$/, '') === path.replace(/\.[^./]+$/, ''))) return 'declared package entry';
  if (ROUTE_DIR_RE.test(path) || ROUTE_FILE_RE.test(path)) return 'route/page/handler convention';
  if (CONFIG_RE.test(path)) return 'config file';
  for (const e of graph.out(m.id)) if (['EXPOSES', 'ROUTES_TO', 'BUILDS'].includes(e.type)) return 'exposes endpoints';
  for (const c of graph.children(m.id)) if (['endpoint', 'route', 'command', 'job', 'workflow', 'component'].includes(c.type)) return 'contains endpoints';
  for (const e of graph.in(m.id)) if (['BUILDS', 'DEPENDS_ON', 'ROUTES_TO', 'DEPLOYS', 'RENDERS'].includes(e.type)) return 'referenced by build or runtime wiring';
  return null;
}

/** Names referenced by calls in a module, last dotted segment included (self.helper -> helper). */
function calledNames(graph) {
  const byModule = new Map();
  for (const type of SOURCE_NODE_TYPES) {
    for (const n of graph.nodes(type)) {
      const calls = Array.isArray(n.attrs?.calls) ? n.attrs.calls : [];
      if (!calls.length) continue;
      const set = byModule.get(n.path) ?? new Set();
      for (const c of calls) {
        const name = typeof c === 'string' ? c : c?.name ?? c?.callee;
        if (!name) continue;
        // A function that only calls itself is still unreferenced from outside.
        if (n.name === name || nameOf(n) === name) continue;
        set.add(name);
        set.add(String(name).split('.').pop());
      }
      byModule.set(n.path, set);
    }
  }
  return byModule;
}

// Languages read by the generic lexical adapter resolve calls only within a file, so "no
// callers" there is not evidence.
const LEXICAL_LANGUAGES = new Set(['go', 'java', 'kotlin', 'csharp', 'rust', 'ruby', 'php', 'swift', 'scala', 'c', 'cpp']);
const lexicalOnly = (m) => ['lexical', 'degraded'].includes(m?.attrs?.parse_quality) || LEXICAL_LANGUAGES.has(m?.attrs?.language);

// Names that reach a function by convention rather than by a call the graph records:
// React components (used as JSX), hooks, event handlers and lifecycle callbacks.
const CONVENTION_NAME = /^(use[A-Z]|handle[A-Z]|on[A-Z]|render[A-Z]?|get(Static|Server)Props$|generate(Metadata|StaticParams)$|loader$|action$|default$)/;

const deadCode = define({
  name: 'dead-code',
  kinds: ['code.dead-code'],
  run(graph) {
    const out = [];
    const called = calledNames(graph);
    // Any call by this name anywhere counts: cross-file resolution is incomplete, and a
    // false "dead" claim costs more than a missed one.
    const anywhere = new Set();
    for (const set of called.values()) for (const n of set) anywhere.add(n);
    const hasImports = graph.edges('IMPORTS').length > 0;
    const perModule = new Map();

    for (const n of codeSymbols(graph)) {
      if (n.attrs.exported !== false) continue;
      const mod = moduleOf(graph, n);
      if (!mod || isTestModule(mod)) continue;
      // Lexically parsed languages resolve calls within a file only; absence of callers
      // there says nothing.
      if (lexicalOnly(mod)) continue;
      const parent = graph.parent(n.id);
      if (parent && (parent.type === 'function' || parent.type === 'method')) continue; // closures are returned or passed, not called by name
      const short = nameOf(n).split('.').pop();
      if (/^__\w+__$/.test(short) || /^(main|init|setup|teardown)$/i.test(short) || /^test/i.test(short)) continue;
      if (CONVENTION_NAME.test(short)) continue;
      if (/\.(jsx|tsx)$/.test(n.path ?? '') && /^[A-Z]/.test(short)) continue; // JSX components
      if ((n.attrs.decorators ?? []).length) continue; // registered by a decorator: reachable by convention
      if (graph.in(n.id, 'CALLS').length) continue;
      if (graph.in(n.id, ['INSTANTIATES', 'REFERENCES']).length) continue;
      if (called.get(n.path)?.has(short) || called.get(n.path)?.has(nameOf(n)) || anywhere.has(short)) continue;
      // Referenced by value in its own module (callback, map(fn), registry): JS counts the
      // declaration among the occurrences, Python does not.
      const occ = n.attrs.name_occurrences;
      if (Number.isInteger(occ) && occ > (mod.attrs?.language === 'python' ? 0 : 1)) continue;
      if (!perModule.has(mod.id)) perModule.set(mod.id, { mod, symbols: [] });
      perModule.get(mod.id).symbols.push(n);
    }
    for (const { mod, symbols } of perModule.values()) {
      const lines = symbols.reduce((a, n) => a + (n.attrs.lines ?? 0), 0);
      const names = symbols.map((n) => nameOf(n));
      const d = base(graph, mod, {
        kind: 'code.dead-code',
        title: symbols.length === 1 ? `Private ${symbolKind(symbols[0])} ${names[0]} in ${mod.path} has no callers` : `${symbols.length} private functions in ${mod.path} have no callers (${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''})`,
        summary: 'no inbound CALLS edge and no call by name anywhere in the repository',
        measurements: { 'symbol.references': 0, 'function.lines': lines },
        thresholds: { callers: 0, note: 'heuristic: absence of static references is not proof of unreachability' },
        benefit: 1 + Math.min(2, lines / 60),
        cost: 1,
        evidence: Math.min(0.6, evidenceFor(mod.attrs)),
        uncertain: 2,
      });
      out.push({
        ...d,
        key: `dead:${mod.id}`,
        evidence: [...d.evidence, ...symbols.slice(0, 8).map((n) => ({ ref: n.id, label: 'inferred', summary: `${nameOf(n)}: ${n.attrs.lines ?? '?'} lines, no callers`, source_ref: n.attrs.start_line ? `${n.path}:${n.attrs.start_line}` : n.path }))],
        confidence: 'medium',
        why_accidental: 'Code nobody calls still has to be read, maintained and kept compiling.',
        essential_considerations: ['It may be reached dynamically (reflection, getattr, string dispatch, a framework convention) in ways static analysis cannot see.'],
        smallest_simplification: `Delete ${names.slice(0, 3).join(', ')}${names.length > 3 ? ' and the rest listed' : ''} (${lines} lines) after confirming nothing references them dynamically.`,
        risks: ['Dynamic dispatch or reflection may reach them.', 'Serialization or plugin hooks may look them up by name.'],
        verification: verificationFor(d.measurements['tests.present'], names.slice(0, 3).map((x) => `Search the repository for the string "${x.split('.').pop()}" to rule out dynamic references.`)),
        uncertainties: [...d.uncertainties, 'Confidence is medium: dynamic imports, reflection and framework conventions are invisible to the static graph.'],
        alternatives: [
          { id: 'retain', summary: 'Keep them if they are reached dynamically or are scaffolding for work already committed to.' },
          { id: 'remove', summary: 'Delete them; version control keeps the history.' },
        ],
        patterns: ['code.remove-dead-code', 'anti-pattern.lava-flow'],
      });
    }

    const entries = declaredEntries(graph);
    if (hasImports) {
      for (const m of [...graph.nodes('module')].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (isTestModule(m)) continue;
        if (lexicalOnly(m)) continue;
        if (graph.in(m.id, 'IMPORTS').length) continue;
        const reason = moduleEntryReason(graph, m, entries);
        if (reason) continue;
        const sloc = m.attrs.sloc ?? 0;
        const d = base(graph, m, {
          kind: 'code.dead-code',
          title: `Module ${m.path ?? m.name} is imported by nothing (${sloc} source lines)`,
          summary: 'zero inbound IMPORTS; not a test, entry point, route, endpoint host or config file',
          measurements: { 'symbol.references': 0, 'module.loc': m.attrs.loc ?? sloc, 'module.consumers': 0 },
          thresholds: { importers: 0, note: 'heuristic: entry points are recognised by name, manifest and convention only' },
          benefit: 1 + Math.min(3, sloc / 150),
          cost: 1 + (sloc > 300 ? 1 : 0),
          evidence: Math.min(0.6, evidenceFor(m.attrs)),
          uncertain: 2,
        });
        out.push({
          ...d,
          confidence: 'medium',
          why_accidental: 'A module nothing imports is either abandoned or reached by wiring the graph cannot see.',
          essential_considerations: ['It may be an entry point loaded by a runner, plugin loader, cron configuration or dynamic import.'],
          smallest_simplification: `Delete ${m.path ?? m.name} once its absence from build, deploy and plugin configuration is confirmed.`,
          risks: ['Loaded by name from configuration, a scheduler or a plugin registry.', 'Executed directly as a script.'],
          verification: verificationFor(d.measurements['tests.present'], [`Search the repository and deployment config for "${baseName(m.path ?? '')}" outside this file.`]),
          uncertainties: [...d.uncertainties, 'Confidence is medium: dynamic imports, reflection and framework conventions are invisible to the static graph.'],
          alternatives: [
            { id: 'retain', summary: 'Keep it if it is an entry point or loaded dynamically; record that in an entry-point list so it stops being flagged.' },
            { id: 'remove', summary: 'Delete the module; version control keeps the history.' },
          ],
          patterns: ['code.remove-dead-code', 'anti-pattern.lava-flow'],
        });
      }
    }
    return out;
  },
});

// ---------------------------------------------------------------------------------------
// Indirection that serves nothing
// ---------------------------------------------------------------------------------------

const ABSTRACT_BASES = new Set(['ABC', 'Protocol', 'ABCMeta', 'abc.ABC', 'typing.Protocol']);

function isInterfaceLike(n) {
  if (n.type === 'interface') return true;
  if (n.type !== 'class') return false;
  const a = n.attrs ?? {};
  return a.abstract === true || ['interface', 'abstract', 'abstract_class', 'protocol'].includes(a.kind) || (a.bases ?? []).some((b) => ABSTRACT_BASES.has(b));
}

/** Distinct modules, other than `selfModule`, that import `moduleId`. */
function importersOf(graph, moduleId) {
  return new Set(graph.in(moduleId, 'IMPORTS').map((e) => e.from).filter((f) => f !== moduleId));
}

const oneImplementationInterface = define({
  name: 'one-implementation-interface',
  kinds: ['code.one-implementation-interface'],
  run(graph) {
    const out = [];
    for (const n of codeSymbols(graph, ['interface', 'class'])) {
      if (!isInterfaceLike(n)) continue;
      const impls = [...new Set(graph.in(n.id, ['EXTENDS', 'IMPLEMENTS']).map((e) => e.from))].sort();
      if (impls.length !== 1) continue;
      const mod = moduleOf(graph, n);
      const consumers = mod ? importersOf(graph, mod.id).size : 0;
      const d = base(graph, n, {
        kind: 'code.one-implementation-interface',
        title: `${nameOf(n)} has exactly one implementation (${nameOf(graph.node(impls[0]))})`,
        summary: `one implementer: ${impls[0]}`,
        measurements: { 'interface.implementations': 1, 'module.consumers': consumers, 'symbol.references': graph.in(n.id).length },
        thresholds: { implementations: 1, note: 'heuristic: a single implementer may still be a deliberate seam for tests or future variants' },
        benefit: 1.5 + Math.min(1.5, graph.in(n.id).length / 10),
        cost: 2,
        evidence: 0.9 * (mod?.attrs?.parse_quality === 'lexical' ? 0.66 : 1),
        uncertain: 2,
      });
      out.push({
        ...d,
        why_accidental: 'An abstraction with one implementer adds a layer to read and keep in sync without enabling any substitution today.',
        essential_considerations: ['It may be a dependency-inversion seam for tests, a published extension point, or have a second implementation already planned.'],
        smallest_simplification: `Merge ${nameOf(n)} into its only implementation ${nameOf(graph.node(impls[0]))} and retarget references to the concrete type.`,
        risks: ['External code may implement the interface.', 'Test doubles may rely on the interface.'],
        alternatives: [
          { id: 'retain', summary: 'Keep the interface if it is a documented extension point, a test seam, or a second implementation is committed.' },
          { id: 'collapse-hierarchy', summary: 'Merge the interface into its single implementer.' },
        ],
        patterns: ['code.collapse-hierarchy', 'anti-pattern.speculative-generality', 'domain.dependency-inversion'],
        uncertainties: [...d.uncertainties, 'Consumers outside the analysed repository are not visible.'],
      });
    }
    return out;
  },
});

// Barrel and package-init files are mostly import/export lists; their "clones" are
// boilerplate, not copied logic.
const BARREL = /(^|\/)(__init__\.py|index\.(js|mjs|cjs|ts|tsx|jsx)|mod\.rs|lib\.rs)$/;

const duplicatedCode = define({
  name: 'duplicated-code',
  kinds: ['code.duplicated-code'],
  defaults: { min_lines: 20, min_similarity: 0.4 },
  run(graph, o) {
    // Pairs that pass the thresholds, then one finding per group of mutually cloned
    // modules: twelve copies of one block are one problem, not sixty-six.
    const pairs = [];
    const seen = new Set();
    for (const m of [...graph.nodes('module')].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (isTestModule(m) || BARREL.test(m.path ?? '')) continue;
      for (const c of m.attrs.clones ?? []) {
        const other = graph.node(`module:${c.other}`);
        if (!other || isTestModule(other) || BARREL.test(c.other)) continue;
        const [a, b] = m.path < c.other ? [m.path, c.other] : [c.other, m.path];
        const key = `${a}|${b}`;
        if (seen.has(key)) continue;
        if ((c.lines ?? 0) < o.min_lines || (c.similarity ?? 0) < o.min_similarity) continue;
        seen.add(key);
        const r0 = (c.ranges ?? [])[0] ?? [1, 1, 1, 1];
        pairs.push({ a, b, lines: c.lines, similarity: c.similarity ?? 0, lineA: m.path === a ? r0[0] : r0[2], lineB: m.path === a ? r0[2] : r0[0] });
      }
    }
    const parent = new Map();
    const find = (x) => (parent.get(x) === x || !parent.has(x) ? (parent.set(x, parent.get(x) ?? x), parent.get(x)) : parent.set(x, find(parent.get(x))).get(x));
    for (const p of pairs) {
      const ra = find(p.a);
      const rb = find(p.b);
      if (ra !== rb) parent.set(rb, ra);
    }
    const groups = new Map();
    for (const p of pairs) {
      const r = find(p.a);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(p);
    }
    const out = [];
    for (const list of groups.values()) {
      const members = [...new Set(list.flatMap((p) => [p.a, p.b]))].sort();
      const lines = Math.max(...list.map((p) => p.lines));
      const sim = Math.max(...list.map((p) => p.similarity));
      const pct = Math.round(sim * 100);
      const tests = members.reduce((n, x) => n + graph.in(`module:${x}`, 'TESTS').length, 0);
      const title = members.length === 2 ? `${lines} duplicated lines (${pct}% similarity) between ${members[0]} and ${members[1]}` : `A ${lines}-line block is duplicated across ${members.length} modules (up to ${pct}% similarity)`;
      out.push({
        kind: 'code.duplicated-code',
        title,
        scope: members,
        key: `clone:${members.join('|')}`,
        evidence: list.slice(0, 8).map((p) => ({ ref: `module:${p.a}`, label: 'observed', summary: `${p.lines} lines shared with ${p.b} (${Math.round(p.similarity * 100)}%)`, source_ref: `${p.a}:${p.lineA}` })),
        measurements: { 'duplication.similarity': sim, 'duplication.instances': members.length, 'tests.present': tests },
        thresholds: { min_lines: o.min_lines, min_similarity: o.min_similarity, note: 'heuristic: token-fingerprint clones ignore identifier names and literals, so near-misses are included' },
        why_accidental: 'The same logic exists more than once, so a fix applied to one copy silently misses the others.',
        essential_considerations: ['The copies may be intentionally independent (different services, different release cadence) or may diverge soon.'],
        smallest_simplification: members.length === 2 ? `Extract the shared ${lines}-line block into one function used by both modules.` : `Extract the shared block into one function and replace the ${members.length} copies one at a time.`,
        invariants: ['Observable behaviour of every call site is unchanged.', 'Public signatures of the modules are unchanged.'],
        risks: ['The copies may differ in a subtle way the fingerprint ignores (names, literals).', 'A shared helper creates a new dependency between the modules.'],
        verification: verificationFor(tests, ['Diff the cloned ranges by hand to confirm they are equivalent before merging them.']),
        recovery: { type: 'revert', notes: 'A single reviewable commit per copy replaced.' },
        quality_impacts: { changeability: 'medium', reliability: 'medium', security: 'low' },
        blast_radius: members.length > 3 ? 'moderate' : 'bounded',
        factors: { benefit: clamp(Math.round(1 + lines / 25 + sim * 2 + (members.length - 2) * 0.5), 1, 5), evidence: 0.6, reversibility: 0.9, blast: members.length > 3 ? 3 : 2, cost: clamp(members.length - 1, 1, 5), uncertainty: 2 },
        uncertainties: ['Clones are found by token fingerprints (medium confidence), not by semantic equivalence.'],
        alternatives: [
          { id: 'retain', summary: 'Keep the copies when they are expected to diverge or live in independently released components.' },
          { id: 'extract-shared-function', summary: 'Extract the common block into one shared function.' },
        ],
        patterns: ['code.extract-function', 'anti-pattern.copy-paste-programming'],
      });
    }
    return out;
  },
});

const SPECULATIVE_RE = /(Factory|Manager|Strategy|Provider|Adapter)$/;
const SPECULATIVE_SNAKE_RE = /_(factory|manager|strategy|provider|adapter)$/;

const speculativeGenerality = define({
  name: 'speculative-generality',
  kinds: ['code.speculative-generality'],
  defaults: { max_consumers: 2 },
  run(graph, o) {
    const out = [];
    const flaggedModules = new Set();
    const emit = (node, mod, implementations, consumers, what) => {
      const d = base(graph, node, {
        kind: 'code.speculative-generality',
        title: `${what} ${nameOf(node)} has ${implementations} implementation(s) and ${consumers} consumer(s)`,
        summary: `name suggests a pluggable abstraction; ${implementations} implementation(s), ${consumers} importing module(s)`,
        measurements: { 'factory.products': implementations, 'interface.implementations': implementations, 'module.consumers': consumers, 'symbol.references': graph.in(node.id).length },
        thresholds: { max_consumers: o.max_consumers, implementations: 1, note: 'heuristic: judged from the name and graph shape alone' },
        benefit: 1.5,
        cost: 2,
        evidence: 0.6,
        uncertain: 3,
      });
      out.push({
        ...d,
        confidence: 'low',
        why_accidental: 'A factory, manager or strategy with one product and almost no consumers is machinery built for variation that has not arrived.',
        essential_considerations: ['The name may be a domain term, or the seam may exist for a committed second implementation or external plugins.'],
        smallest_simplification: `Inline ${nameOf(node)} into its single consumer or implementation and delete the wrapper.`,
        risks: ['External consumers may rely on it.', 'The name may be legitimate domain vocabulary rather than a pattern.'],
        uncertainties: [...d.uncertainties, 'Confidence is low: this is inferred from naming and counts, not from behaviour.'],
        alternatives: [
          { id: 'retain', summary: 'Keep it when a second implementation is planned or the name is real domain vocabulary.' },
          { id: 'inline-wrapper', summary: 'Inline the abstraction into its one implementation.' },
        ],
        patterns: ['anti-pattern.speculative-generality', 'code.inline-wrapper', 'code.collapse-hierarchy'],
      });
    };

    for (const c of codeSymbols(graph, ['class'])) {
      if (!SPECULATIVE_RE.test(nameOf(c))) continue;
      const mod = moduleOf(graph, c);
      const impls = new Set(graph.in(c.id, ['EXTENDS', 'IMPLEMENTS']).map((e) => e.from)).size;
      const consumers = mod ? importersOf(graph, mod.id).size : 0;
      if (impls > 1 || consumers > o.max_consumers) continue;
      if (mod) flaggedModules.add(mod.id);
      emit(c, mod, impls, consumers, 'Class');
    }
    for (const m of [...graph.nodes('module')].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (isTestModule(m) || flaggedModules.has(m.id)) continue;
      const stem = baseName(m.path ?? '');
      if (!SPECULATIVE_RE.test(stem) && !SPECULATIVE_SNAKE_RE.test(stem)) continue;
      const classes = graph.children(m.id, 'class');
      const consumers = importersOf(graph, m.id).size;
      if (classes.length > 1 || consumers > o.max_consumers) continue;
      emit(m, m, classes.length, consumers, 'Module');
    }
    return out;
  },
});

// ---------------------------------------------------------------------------------------
// Statements after an unconditional jump
// ---------------------------------------------------------------------------------------

const unreachableCode = define({
  name: 'unreachable-code',
  kinds: ['code.unreachable-code'],
  run(graph) {
    const out = [];
    for (const n of codeSymbols(graph)) {
      const spots = Array.isArray(n.attrs.unreachable) ? n.attrs.unreachable.filter((u) => Number.isFinite(u?.line)) : [];
      if (!spots.length) continue;
      const first = spots[0];
      const d = base(graph, n, {
        kind: 'code.unreachable-code',
        title: `${nameOf(n)} has ${spots.length === 1 ? 'unreachable code' : `${spots.length} unreachable statements`} after ${first.after} at line ${first.line}`,
        summary: `${spots.length} statement(s) follow an unconditional ${first.after} in the same block and can never run`,
        measurements: { 'symbol.references': 0 },
        thresholds: { note: 'syntactic: statements after return/throw/raise/break/continue in the same block' },
        benefit: 1 + Math.min(1, spots.length / 3),
        cost: 1,
        evidence: 0.9,
      });
      out.push({
        ...d,
        evidence: [{ ...d.evidence[0], summary: d.evidence[0].summary, source_ref: `${n.path}:${first.line}` }],
        why_accidental: 'Code that can never run misleads readers about what the function does and hides a likely logic slip.',
        essential_considerations: ['It may mark a branch the author meant to guard with a condition; check intent before deleting.'],
        smallest_simplification: `Delete the statements from line ${first.line} in ${nameOf(n)}, or fix the jump above them if they were meant to run.`,
        risks: ['The jump above may be the mistake, in which case the dead code holds the intended behaviour.'],
        alternatives: [
          { id: 'retain', summary: 'Keep it only if it documents intent; then turn it into a comment.' },
          { id: 'remove', summary: 'Delete the unreachable statements; version control keeps the history.' },
        ],
        patterns: ['code.remove-dead-code'],
      });
    }
    return out;
  },
});

export default [
  longFunction,
  complexFunction,
  deepNesting,
  longParameterList,
  largeClass,
  largeModule,
  deadCode,
  unreachableCode,
  oneImplementationInterface,
  duplicatedCode,
  speculativeGenerality,
];
