// One dependency-injection rule: a container registration names a service type, the
// implementation type the container gives for it, and a lifetime. Library spellings are
// data (DI_SYNTAX, one row per spelling); there is no per-library extractor. The engine
// reads registrations from the shared lexical view, so text in comments and strings
// never counts. Unknown or ambiguous names stay unresolved at link time, never guessed.
import { LANGUAGE_IDS } from '../../runtime/graph/languages.mjs';
import { argumentsOf, callsIn, closing, MAX_OPERATIONS, stringValue, view } from './contract-scan.mjs';

const L = LANGUAGE_IDS;

/**
 * Row fields:
 *   container   the library spelling's container name, carried on the facts
 *   languages   the language ids the spelling is written in
 *   kind        'call' (service/implementation from type arguments or arguments),
 *               'fluent' (a call chained into more calls), 'bean', 'component',
 *               'binds' (an annotated method) or 'provider' (an object literal)
 *   names       call names; an object maps each name to its lifetime
 *   service / implementation  where the type is written: { typeArg: n }, { arg: n }
 *               or { named: 'key' }; a descriptor may carry several, tried in order
 *   chain       for 'fluent': { serviceCall / implementationCall: { name, typeArg|arg },
 *               lifetimes: { CallName: lifetime }, lifetimeArgCalls: names whose first
 *               argument spells the lifetime, selfCall: a self-binding chain call }
 *   annotations for the annotation kinds: the marker names
 *   receiver    a required receiver name, `receiverPattern` a pattern the text before
 *               the call name must end with (PHP `->` / `::`)
 *   lifetimeNamed  { arg, values } for a named argument that spells the lifetime
 *   defaultLifetime  the lifetime when the code names none
 */
export const DI_SYNTAX = [
  {
    container: 'microsoft-di', languages: [L.CSHARP], kind: 'call',
    names: {
      AddSingleton: 'singleton', TryAddSingleton: 'singleton',
      AddScoped: 'scoped', TryAddScoped: 'scoped',
      AddTransient: 'transient', TryAddTransient: 'transient',
    },
    service: { typeArg: 0, arg: 0 }, implementation: { typeArg: 1, arg: 1 },
    selfWhenSingleTypeArg: true,
  },
  {
    container: 'autofac', languages: [L.CSHARP], kind: 'fluent',
    names: ['RegisterType'], implementation: { typeArg: 0 },
    chain: {
      serviceCall: { name: 'As', typeArg: 0 }, selfCall: 'AsSelf',
      lifetimes: { SingleInstance: 'singleton', InstancePerLifetimeScope: 'scoped', InstancePerRequest: 'scoped', InstancePerDependency: 'transient' },
    },
    defaultLifetime: 'transient',
  },
  {
    container: 'guice', languages: [L.JAVA, L.KOTLIN], kind: 'fluent',
    names: ['bind'], service: { arg: 0 },
    chain: {
      implementationCall: { name: 'to', arg: 0 },
      lifetimes: { asEagerSingleton: 'singleton' }, lifetimeArgCalls: ['in'],
    },
    defaultLifetime: 'transient',
  },
  {
    container: 'spring', languages: [L.JAVA, L.KOTLIN], kind: 'bean',
    annotations: ['Bean'], scopeAnnotation: 'Scope', defaultLifetime: 'singleton',
  },
  {
    container: 'spring', languages: [L.JAVA, L.KOTLIN], kind: 'component',
    annotations: ['Component', 'Service', 'Repository', 'Controller', 'RestController'],
    defaultLifetime: 'singleton', scanned: true,
  },
  {
    container: 'dagger', languages: [L.JAVA, L.KOTLIN], kind: 'binds',
    annotations: ['Binds'], singletonAnnotation: 'Singleton', defaultLifetime: 'unknown',
  },
  {
    container: 'nest-angular', languages: [L.TYPESCRIPT, L.JAVASCRIPT], kind: 'provider',
    names: ['provide', 'useClass'], defaultLifetime: 'singleton',
  },
  {
    container: 'inversify', languages: [L.TYPESCRIPT, L.JAVASCRIPT], kind: 'fluent',
    names: ['bind'], service: { typeArg: 0, arg: 0 },
    chain: {
      implementationCall: { name: 'to', arg: 0 },
      lifetimes: { inSingletonScope: 'singleton', inRequestScope: 'scoped', inTransientScope: 'transient' },
    },
    defaultLifetime: 'transient',
  },
  {
    container: 'laravel', languages: [L.PHP], kind: 'call',
    names: { bind: 'transient', singleton: 'singleton', scoped: 'scoped' },
    service: { arg: 0 }, implementation: { arg: 1 },
    receiverPattern: /(?:->|::)\s*$/,
  },
  {
    container: 'injector', languages: [L.PYTHON], kind: 'call',
    names: { bind: 'transient' },
    service: { arg: 0 }, implementation: { named: 'to' },
    lifetimeNamed: { arg: 'scope', values: { singleton: 'singleton' } },
    defaultLifetime: 'transient',
  },
  {
    container: 'wire', languages: [L.GO], kind: 'call',
    names: { Bind: 'unknown' }, receiver: 'wire',
    service: { arg: 0 }, implementation: { arg: 1 },
  },
];

// --------------------------------------------------------------------- type names

/**
 * The simple name a type reference carries: namespaces, generic arguments, `::class`,
 * `.class`, `::class.java`, `*`/`&`, `new(...)` and `typeof(...)` stripped. A string
 * literal gives its value. Anything that is not one identifier after stripping stays
 * as written, so the resolver leaves it unresolved.
 */
export function simpleTypeName(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const lit = stringValue(s);
  if (lit !== null) return lit;
  let m = /^typeof\s*\(([\s\S]*)\)$/.exec(s);
  if (m) s = m[1].trim();
  m = /^new\s*\(([\s\S]*)\)$/.exec(s);
  if (m) s = m[1].trim();
  m = /^new\s+([\s\S]*?)\s*(?:\(.*\))?$/.exec(s);
  if (m && !/[\s,]/.test(m[1])) s = m[1].trim();
  s = s.replace(/::class\.java\s*$/, '').replace(/::class\s*$/, '').replace(/\.class\s*$/, '');
  s = s.replace(/^[*&]+\s*/, '').replace(/\s*\[\]\s*$/, '');
  const lt = s.indexOf('<');
  if (lt >= 0) s = s.slice(0, lt);
  s = s.split(/::|\\|\./).filter(Boolean).pop() ?? s;
  s = s.replace(/^[*&]+\s*/, '').trim();
  return /^[A-Za-z_$][\w$]*$/.test(s) ? s : String(raw).trim();
}

const isSimple = (s) => typeof s === 'string' && /^[A-Za-z_$][\w$]*$/.test(s);

// --------------------------------------------------------------------- call shapes

function splitTop(raw) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if ('<([{'.includes(c)) depth++;
    else if ('>)]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { out.push(raw.slice(from, i).trim()); from = i + 1; }
  }
  const last = raw.slice(from).trim();
  if (last) out.push(last);
  return out;
}

/** `Name<T...>(...)` calls, which `callsIn` cannot see (it needs `(` after the name). */
function genericCalls(lx, names) {
  const out = [];
  for (const m of lx.code.matchAll(/\b([A-Za-z_]\w*)\s*</g)) {
    if (!names.has(m[1])) continue;
    const lt = m.index + m[0].length - 1;
    const gt = closing(lx.code, lt, '<', '>');
    if (gt < 0 || gt - lt > 500) continue;
    if (/[;{}]/.test(lx.code.slice(lt, gt))) continue;
    let open = gt + 1;
    while (open < lx.code.length && /\s/.test(lx.code[open])) open++;
    if (lx.code[open] !== '(') continue;
    const end = closing(lx.code, open);
    if (end < 0) continue;
    const before = lx.code.slice(Math.max(0, m.index - 200), m.index);
    out.push({
      name: m[1], index: m.index, end, line: lx.lineOf(m.index), before,
      receiver: /([A-Za-z_][\w.]*)\.\s*$/.exec(before)?.[1] ?? '',
      typeArgs: splitTop(lx.plain.slice(lt + 1, gt)),
      args: argumentsOf(lx.plain.slice(open + 1, end)),
    });
    if (out.length >= 10000) break;
  }
  return out;
}

/** The `.name<...>(...)` calls chained directly after a call that ended at `end`. */
function chainAfter(lx, end) {
  const out = [];
  let pos = end + 1;
  for (let n = 0; n < 20; n++) {
    const m = /^\s*\.\s*([A-Za-z_]\w*)\s*/.exec(lx.code.slice(pos, pos + 300));
    if (!m) break;
    let at = pos + m[0].length;
    let typeArgs = [];
    if (lx.code[at] === '<') {
      const gt = closing(lx.code, at, '<', '>');
      if (gt < 0 || gt - at > 500) break;
      typeArgs = splitTop(lx.plain.slice(at + 1, gt));
      at = gt + 1;
      while (at < lx.code.length && /\s/.test(lx.code[at])) at++;
    }
    if (lx.code[at] !== '(') break;
    const close = closing(lx.code, at);
    if (close < 0) break;
    out.push({ name: m[1], index: pos + m[0].indexOf(m[1]), end: close, typeArgs, args: argumentsOf(lx.plain.slice(at + 1, close)) });
    pos = close + 1;
  }
  return out;
}

function pick(desc, call) {
  if (!desc) return undefined;
  if (desc.typeArg !== undefined && call.typeArgs?.[desc.typeArg] !== undefined) return call.typeArgs[desc.typeArg];
  if (desc.named !== undefined && call.args?.named?.[desc.named] !== undefined) return call.args.named[desc.named];
  if (desc.arg !== undefined && call.args?.positional?.[desc.arg] !== undefined) return call.args.positional[desc.arg];
  return undefined;
}

const nameList = (row) => (Array.isArray(row.names) ? row.names : Object.keys(row.names ?? {}));
const lifetimeOfName = (row, name) => (Array.isArray(row.names) ? undefined : row.names?.[name]);

function chainLifetime(row, chain) {
  for (const c of chain) {
    const byName = row.chain?.lifetimes?.[c.name];
    if (byName) return byName;
    if (row.chain?.lifetimeArgCalls?.includes(c.name)) {
      const raw = c.args.positional[0] ?? '';
      if (/singleton/i.test(raw)) return 'singleton';
      if (/request|session|scoped/i.test(raw)) return 'scoped';
      if (/prototype|transient|noscope/i.test(raw)) return 'transient';
    }
  }
  return row.defaultLifetime ?? 'unknown';
}

// --------------------------------------------------------------------- annotations

/** Skip a run of annotations/attributes in `code` from `at`; returns the next offset. */
function skipAnnotations(lx, at) {
  let pos = at;
  for (let n = 0; n < 20; n++) {
    const m = /^\s*@[\w.]+/.exec(lx.code.slice(pos, pos + 200));
    if (!m) break;
    pos += m[0].length;
    let q = pos;
    while (q < lx.code.length && /\s/.test(lx.code[q])) q++;
    if (lx.code[q] === '(') {
      const close = closing(lx.code, q);
      if (close < 0) break;
      pos = close + 1;
    }
  }
  return pos;
}

/** The annotation block around an annotation: from the previous `;`/`}` to the declaration. */
function annotationRegion(lx, index, declAt) {
  let start = index;
  while (start > 0 && !';{}'.includes(lx.code[start - 1])) start--;
  return lx.plain.slice(start, declAt);
}

function scopeLifetime(region, dflt) {
  const m = /@(?:[\w.]*\.)?Scope\s*\(([^)]*)\)/.exec(region) ?? /@(?:[\w.]*\.)?Scope\b/.exec(region);
  if (!m) return dflt;
  const raw = m[1] ?? '';
  if (/prototype/i.test(raw)) return 'transient';
  if (/request|session/i.test(raw)) return 'scoped';
  if (/singleton/i.test(raw)) return 'singleton';
  return dflt;
}

function beanCandidate(lx, row, index) {
  const declAt = skipAnnotations(lx, index);
  const head = lx.code.slice(declAt, declAt + 600);
  const region = annotationRegion(lx, index, declAt);
  const lifetime = scopeLifetime(region, row.defaultLifetime ?? 'singleton');
  // Kotlin: `fun name(...): ServiceType = Impl(...)` or a block returning `Impl(`.
  let m = /^\s*(?:public|private|protected|internal|open|final|suspend|\s)*fun\s+(?:<[^>]*>\s*)?[A-Za-z_]\w*\s*\(/.exec(head);
  if (m) {
    const open = declAt + m[0].length - 1;
    const close = closing(lx.code, open);
    if (close < 0) return null;
    const tail = lx.code.slice(close + 1, close + 400);
    const ret = /^\s*:\s*([A-Za-z_][\w.]*(?:<[^>]*>)?)/.exec(tail);
    if (!ret) return null;
    const body = lx.code.slice(close + 1, close + 3000);
    const impl = /\breturn\s+(?:new\s+)?([A-Za-z_][\w.]*)\s*\(/.exec(body) ?? /=\s*(?:new\s+)?([A-Za-z_][\w.]*)\s*\(/.exec(body);
    if (!impl) return null;
    return { service: ret[1], implementation: impl[1], lifetime };
  }
  // Java: `ServiceType name(...) { return new Impl(...); }`
  m = /^\s*(?:public|protected|private|static|final|\s)*([A-Za-z_][\w.]*(?:<[^>]*>)?(?:\[\])?)\s+[A-Za-z_]\w*\s*\(/.exec(head);
  if (!m) return null;
  const open = declAt + m[0].length - 1;
  const close = closing(lx.code, open);
  if (close < 0) return null;
  const brace = lx.code.indexOf('{', close);
  if (brace < 0 || brace - close > 300) return null;
  const bodyEnd = closing(lx.code, brace, '{', '}');
  if (bodyEnd < 0) return null;
  const impl = /\breturn\s+new\s+([A-Za-z_][\w.]*)\s*\(/.exec(lx.code.slice(brace, bodyEnd));
  if (!impl) return null;
  return { service: m[1], implementation: impl[1], lifetime };
}

function componentCandidates(lx, row, index) {
  const declAt = skipAnnotations(lx, index);
  const head = lx.code.slice(declAt, declAt + 800);
  const m = /^(?:public|private|protected|internal|open|final|abstract|data|sealed|\s)*class\s+([A-Za-z_]\w*)/.exec(head);
  if (!m) return [];
  const impl = m[1];
  let at = m[0].length;
  // Skip generic parameters and a Kotlin primary constructor before the supertype list.
  if (head[at] === '<') {
    const gt = closing(head, at, '<', '>');
    if (gt > 0) at = gt + 1;
  }
  let q = at;
  while (q < head.length && /\s/.test(head[q])) q++;
  if (head[q] === '(') {
    const close = closing(head, q);
    if (close > 0) at = close + 1;
  }
  const tail = head.slice(at, head.indexOf('{', at) < 0 ? undefined : head.indexOf('{', at));
  let list = null;
  const implementsAt = tail.search(/\bimplements\b/);
  if (implementsAt >= 0) list = tail.slice(implementsAt + 'implements'.length);
  else {
    // Kotlin supertypes follow `:`; Java without `implements` binds nothing here.
    const colon = tail.indexOf(':');
    if (colon >= 0 && !/\bextends\b/.test(tail)) list = tail.slice(colon + 1);
  }
  if (list === null) return [];
  return splitTop(list).map((raw) => simpleTypeName(raw.replace(/\(.*\)\s*$/, '').trim()))
    .filter((s) => isSimple(s) && s !== impl)
    .map((service) => ({ service, implementation: impl, lifetime: row.defaultLifetime ?? 'singleton' }));
}

function bindsCandidate(lx, row, index) {
  const declAt = skipAnnotations(lx, index);
  const head = lx.code.slice(declAt, declAt + 600);
  const region = annotationRegion(lx, index, declAt);
  const lifetime = new RegExp(`@(?:[\\w.]*\\.)?${row.singletonAnnotation}\\b`).test(region)
    ? 'singleton' : (row.defaultLifetime ?? 'unknown');
  // Kotlin: `abstract fun name(impl: ImplType): ServiceType`
  let m = /^(?:public|private|protected|internal|abstract|\s)*fun\s+[A-Za-z_]\w*\s*\(\s*(?:@[\w.]+(?:\s*\([^)]*\))?\s*)*[A-Za-z_]\w*\s*:\s*([A-Za-z_][\w.]*)/.exec(head);
  if (m) {
    const open = head.indexOf('(');
    const close = closing(head, open);
    const ret = close > 0 ? /^\s*:\s*([A-Za-z_][\w.]*)/.exec(head.slice(close + 1)) : null;
    return ret ? { service: ret[1], implementation: m[1], lifetime } : null;
  }
  // Java: `abstract ServiceType name(ImplType impl);`
  m = /^(?:public|protected|private|abstract|\s)*([A-Za-z_][\w.]*(?:<[^>]*>)?)\s+[A-Za-z_]\w*\s*\(\s*(?:@[\w.]+(?:\s*\([^)]*\))?\s*)*(?:final\s+)?([A-Za-z_][\w.]*(?:<[^>]*>)?)\s+[A-Za-z_]\w*/.exec(head);
  if (!m) return null;
  return { service: m[1], implementation: m[2], lifetime };
}

// --------------------------------------------------------------------- providers

function providerCandidate(lx, index) {
  // The opening brace of the object holding `provide:`: the nearest unmatched `{` before it.
  let depth = 0;
  let open = -1;
  for (let i = index - 1; i >= Math.max(0, index - 2000); i--) {
    if (lx.code[i] === '}') depth++;
    else if (lx.code[i] === '{') {
      if (depth === 0) { open = i; break; }
      depth--;
    }
  }
  if (open < 0) return null;
  const close = closing(lx.code, open, '{', '}');
  if (close < 0 || close - open > 4000) return null;
  const fields = argumentsOf(lx.plain.slice(open + 1, close)).named;
  if (fields.provide === undefined || fields.useclass === undefined) return null;
  const scope = fields.scope ?? '';
  const lifetime = /transient/i.test(scope) ? 'transient' : /request/i.test(scope) ? 'scoped' : 'singleton';
  return { service: fields.provide.trim(), implementation: fields.useclass.trim(), lifetime, index: open };
}

// --------------------------------------------------------------------- the engine

const triggerNames = () => {
  const names = new Set();
  for (const row of DI_SYNTAX) {
    for (const n of nameList(row)) names.add(n);
    for (const n of row.annotations ?? []) names.add(n);
    if (row.scopeAnnotation) names.add(row.scopeAnnotation);
    if (row.singletonAnnotation) names.add(row.singletonAnnotation);
  }
  return names;
};

// Most files name none of the table's calls or annotations: a text test spares them the lexer.
const TRIGGER = new RegExp(`\\b(?:${[...triggerNames()].join('|')})\\b`);

export function diCandidates(path, text, lang) {
  if (!TRIGGER.test(text)) return [];
  const rows = DI_SYNTAX.filter((r) => r.languages.includes(lang));
  if (!rows.length) return [];
  const lx = view(text, lang);
  const out = [];
  const seen = new Set();
  const push = (row, serviceRaw, implRaw, lifetime, index) => {
    if (out.length >= MAX_OPERATIONS) return;
    const service = simpleTypeName(serviceRaw);
    const implementation = simpleTypeName(implRaw);
    if (!service || !implementation || !isSimple(implementation)) return;
    const key = `${row.container}|${service}|${implementation}|${lifetime}|${index}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      container: row.container, service, implementation, lifetime,
      line: lx.lineOf(index), index,
      ...(row.scanned ? { scanned: true } : {}),
    });
  };

  const callRows = rows.filter((r) => r.kind === 'call' || r.kind === 'fluent');
  if (callRows.length) {
    const genericNames = new Set(callRows.flatMap(nameList));
    const plain = callsIn(lx).map((c) => ({ ...c, typeArgs: [] }));
    const generic = genericCalls(lx, genericNames);
    const calls = [...plain, ...generic].sort((a, b) => a.index - b.index);
    for (const call of calls) {
      if (out.length >= MAX_OPERATIONS) break;
      for (const row of callRows) {
        if (!nameList(row).includes(call.name)) continue;
        if (row.receiver && call.receiver !== row.receiver
          && !new RegExp(`(?:^|\\.)${row.receiver}\\s*$`).test(call.receiver)) continue;
        if (row.receiverPattern && !row.receiverPattern.test(call.before)) continue;
        if (row.kind === 'call') {
          let service = pick(row.service, call);
          let implementation = pick(row.implementation, call);
          if (row.selfWhenSingleTypeArg && call.typeArgs.length === 1) {
            if (call.args.positional.length) continue; // an instance/factory overload, not a self-binding
            service = call.typeArgs[0];
            implementation = call.typeArgs[0];
          }
          if (service === undefined || implementation === undefined) continue;
          let lifetime = lifetimeOfName(row, call.name) ?? row.defaultLifetime ?? 'unknown';
          if (row.lifetimeNamed) {
            const raw = call.args.named[row.lifetimeNamed.arg];
            const named = raw !== undefined ? row.lifetimeNamed.values[simpleTypeName(raw)?.toLowerCase()] : undefined;
            lifetime = named ?? (row.defaultLifetime ?? lifetime);
          }
          push(row, service, implementation, lifetime, call.index);
        } else {
          const chain = chainAfter(lx, call.end);
          let service = pick(row.service, call);
          let implementation = pick(row.implementation, call);
          const svcCall = row.chain?.serviceCall ? chain.find((c) => c.name === row.chain.serviceCall.name) : null;
          if (svcCall) service = pick(row.chain.serviceCall, svcCall);
          const implCall = row.chain?.implementationCall ? chain.find((c) => c.name === row.chain.implementationCall.name) : null;
          if (implCall) implementation = pick(row.chain.implementationCall, implCall);
          if (row.chain?.implementationCall && !implCall) continue;
          if (row.chain?.serviceCall && !svcCall) {
            if (row.chain.selfCall && chain.some((c) => c.name === row.chain.selfCall)) service = implementation;
            else continue;
          }
          if (service === undefined || implementation === undefined) continue;
          push(row, service, implementation, chainLifetime(row, chain), call.index);
        }
      }
    }
  }

  for (const row of rows) {
    if (out.length >= MAX_OPERATIONS) break;
    if (row.kind === 'bean' || row.kind === 'binds' || row.kind === 'component') {
      const names = row.annotations.join('|');
      for (const m of lx.code.matchAll(new RegExp(`@(?:[\\w.]*\\.)?(?:${names})\\b`, 'g'))) {
        if (out.length >= MAX_OPERATIONS) break;
        if (row.kind === 'bean') {
          const c = beanCandidate(lx, row, m.index);
          if (c) push(row, c.service, c.implementation, c.lifetime, m.index);
        } else if (row.kind === 'binds') {
          const c = bindsCandidate(lx, row, m.index);
          if (c) push(row, c.service, c.implementation, c.lifetime, m.index);
        } else {
          for (const c of componentCandidates(lx, row, m.index)) push(row, c.service, c.implementation, c.lifetime, m.index);
        }
      }
    } else if (row.kind === 'provider') {
      for (const m of lx.code.matchAll(/\bprovide\s*:/g)) {
        if (out.length >= MAX_OPERATIONS) break;
        const c = providerCandidate(lx, m.index);
        if (c) push(row, c.service, c.implementation, c.lifetime, c.index);
      }
    }
  }

  out.sort((a, b) => a.index - b.index || (a.container < b.container ? -1 : a.container > b.container ? 1 : 0)
    || (a.service < b.service ? -1 : a.service > b.service ? 1 : 0)
    || (a.implementation < b.implementation ? -1 : a.implementation > b.implementation ? 1 : 0));
  return out;
}