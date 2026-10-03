// Dockerfiles and Compose files (spec §15.2). A Dockerfile becomes an `image:<path>` node
// with per-stage facts; a Compose service becomes a deployable `service:compose/<name>`.
//
// SECRECY: ENV/ARG/environment entries are recorded by NAME only. A literal value is never
// stored; we only note that a credential-named variable has one baked in.

import { nodeFact, edgeFact } from '../../../runtime/graph/facts.mjs';
import {
  isObj, asArray, asString, uniqSorted, provMaker, dirOf, resolveRel, parseDocs, parseImage, SECRET_NAME,
} from './util.mjs';
import { posix } from 'node:path';

const CURL_PIPE_SHELL = /\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+(-\w+\s+)?)?(ba|z|da)?sh\b/;

/** Join continuation lines and drop comments; returns [{line, text}] logical instructions. */
const INSTRUCTIONS = new Set(['FROM', 'RUN', 'CMD', 'LABEL', 'MAINTAINER', 'EXPOSE', 'ENV', 'ADD', 'COPY', 'ENTRYPOINT', 'VOLUME', 'USER', 'WORKDIR', 'ARG', 'ONBUILD', 'STOPSIGNAL', 'HEALTHCHECK', 'SHELL']);

function logicalLines(text) {
  const raw = text.split(/\r?\n/);
  const out = [];
  let buf = null;
  let startLine = 0;
  // BuildKit heredocs (`RUN <<EOF ... EOF`, `COPY <<EOF /path`): the body is part of the
  // instruction, never instructions of its own (a script line `from x import y` is not FROM).
  let heredoc = null;
  raw.forEach((l, i) => {
    if (heredoc) {
      buf += `\n${l}`;
      if ((heredoc.strip ? l.replace(/^\t+/, '') : l).trim() === heredoc.word) heredoc = null;
      if (!heredoc && buf !== null) {
        out.push({ line: startLine, text: buf.trim() });
        buf = null;
      }
      return;
    }
    if (buf === null && /^\s*#/.test(l)) return;
    if (buf !== null && /^\s*#/.test(l)) return; // comment lines inside a continuation
    if (buf === null && l.trim() === '') return;
    const cont = /\\\s*$/.test(l);
    const piece = l.replace(/\\\s*$/, '');
    if (buf === null) {
      buf = piece;
      startLine = i + 1;
    } else {
      buf += ` ${piece.trim()}`;
    }
    const hd = /<<(-?)\s*["']?([A-Za-z_][\w]*)["']?/.exec(piece);
    if (hd && !cont) {
      heredoc = { word: hd[2], strip: hd[1] === '-' };
      return;
    }
    if (!cont) {
      out.push({ line: startLine, text: buf.trim() });
      buf = null;
    }
  });
  if (buf !== null) out.push({ line: startLine, text: buf.trim() });
  return out;
}

/** Variable names assigned by ENV/ARG; values are deliberately discarded. */
function assignedNames(args) {
  const names = [];
  const eq = /(?:^|\s)([A-Za-z_][\w.-]*)=(?:"[^"]*"|'[^']*'|\S*)/g;
  let m;
  while ((m = eq.exec(args)) !== null) names.push({ name: m[1], has_value: !/=(""|''|)(\s|$)/.test(m[0]) });
  if (names.length === 0) {
    const legacy = /^([A-Za-z_][\w.-]*)(\s+(.*))?$/.exec(args);
    if (legacy) names.push({ name: legacy[1], has_value: !!legacy[3] });
  }
  return names;
}

const isRootUser = (u) => u == null || /^(root|0)$/i.test(String(u).split(':')[0]);

/** @returns {object[]} facts for one Dockerfile */
export function extractDockerfile(path, text) {
  const mk = provMaker(path);
  const dir = dirOf(path);
  const stages = [];
  const globalArgs = [];
  let cur = null;
  const secretEnv = new Set();
  const secretArg = new Set();
  const expose = new Set();
  let health = false;
  let addUrl = 0;
  let curlPipe = 0;
  let firstLine = 1;

  for (const { line, text: t } of logicalLines(text)) {
    const m = /^([A-Za-z]+)\s*([\s\S]*)$/.exec(t);
    if (!m) continue;
    const ins = m[1].toUpperCase();
    if (!INSTRUCTIONS.has(ins)) continue;
    const args = m[2];
    if (ins === 'FROM') {
      const parts = args.split(/\s+/).filter((p) => !p.startsWith('--'));
      const as = parts.findIndex((p) => p.toUpperCase() === 'AS');
      const image = parts[0] ?? '';
      const prior = stages.find((s) => s.name && s.name === image);
      const ref = parseImage(image);
      cur = {
        index: stages.length, name: as >= 0 ? parts[as + 1] ?? null : null, line,
        base: ref.raw, base_is_stage: !!prior,
        base_pinned: ref.pinned, base_latest: !prior && ref.latest, base_variable: ref.variable,
        user: null, add_urls: 0, curl_pipe_shell: 0, run_count: 0,
      };
      if (stages.length === 0) firstLine = line;
      stages.push(cur);
    } else if (!cur) {
      if (ins === 'ARG') for (const a of assignedNames(args)) globalArgs.push(a.name);
    } else if (ins === 'USER') {
      cur.user = args.split(/\s+/)[0] ?? null;
    } else if (ins === 'ADD') {
      const srcs = args.split(/\s+/).filter((p) => !p.startsWith('--'));
      if (srcs.slice(0, -1).some((s) => /^https?:\/\//i.test(s))) {
        cur.add_urls += 1;
        addUrl += 1;
      }
    } else if (ins === 'RUN') {
      cur.run_count += 1;
      if (CURL_PIPE_SHELL.test(args)) {
        cur.curl_pipe_shell += 1;
        curlPipe += 1;
      }
    } else if (ins === 'ENV') {
      for (const a of assignedNames(args)) if (SECRET_NAME.test(a.name)) secretEnv.add(a.name);
    } else if (ins === 'ARG') {
      for (const a of assignedNames(args)) if (SECRET_NAME.test(a.name)) secretArg.add(a.name);
    } else if (ins === 'EXPOSE') {
      for (const p of args.split(/\s+/)) if (p) expose.add(p.replace(/\/(tcp|udp)$/i, ''));
    } else if (ins === 'HEALTHCHECK') {
      if (!/^NONE\b/i.test(args)) health = true;
    }
  }
  if (stages.length === 0) return []; // not a Dockerfile (or only ARGs): nothing to claim
  for (const g of globalArgs) if (SECRET_NAME.test(g)) secretArg.add(g);
  const last = stages[stages.length - 1];
  // An unset USER in the final stage means root unless an earlier stage's USER leaks through FROM.
  const finalUser = last.user;
  const facts = [nodeFact('image', path, {
    name: path,
    path,
    attrs: {
      kind: 'Dockerfile', dir,
      stage_count: stages.length, multi_stage: stages.length > 1,
      stages: stages.map((s) => ({
        index: s.index, name: s.name, base: s.base, base_is_stage: s.base_is_stage, base_pinned: s.base_pinned,
        base_latest: s.base_latest, base_variable: s.base_variable, user: s.user,
        runs_as_root: isRootUser(s.user), add_urls: s.add_urls, curl_pipe_shell: s.curl_pipe_shell,
      })),
      final_user: finalUser,
      final_stage_root: isRootUser(finalUser),
      add_url: addUrl, curl_pipe_shell: curlPipe,
      secret_env_names: [...secretEnv].sort(),
      secret_arg_names: [...secretArg].sort(),
      expose: [...expose].sort((a, b) => Number(a) - Number(b) || (a < b ? -1 : 1)),
      healthcheck: health,
      unpinned_bases: stages.filter((s) => !s.base_is_stage && !s.base_pinned && !s.base_variable).length,
      latest_bases: stages.filter((s) => s.base_latest).map((s) => s.base).sort(),
    },
  }, mk(firstLine))];
  facts.push(nodeFact('build_target', dir, { name: dir, path, attrs: { has_dockerfile: true } }, mk(firstLine)));
  facts.push(edgeFact('BUILDS', `build_target:${dir}`, `image:${path}`, {}, mk(firstLine)));
  for (const s of stages) {
    if (s.base_is_stage || s.base_variable || !s.base) continue;
    const ref = parseImage(s.base);
    facts.push(nodeFact('image', ref.raw, {
      name: ref.raw, attrs: { external: true, pinned: ref.pinned, tag_latest: ref.latest },
    }, mk(s.line)));
    facts.push(edgeFact('DEPENDS_ON', `image:${path}`, `image:${ref.raw}`, { stage: s.name ?? String(s.index) }, mk(s.line)));
  }
  return facts;
}

/** Parse a Compose port entry into {published, target, protocol, host_ip}. */
function parsePort(p) {
  if (isObj(p)) {
    return {
      published: p.published ?? null, target: p.target ?? null, protocol: p.protocol ?? 'tcp', host_ip: asString(p.host_ip),
    };
  }
  const [spec, proto] = String(p).split('/');
  const parts = spec.split(':');
  if (parts.length === 1) return { published: null, target: parts[0], protocol: proto ?? 'tcp', host_ip: null };
  if (parts.length === 2) return { published: parts[0], target: parts[1], protocol: proto ?? 'tcp', host_ip: null };
  return { published: parts[parts.length - 2], target: parts[parts.length - 1], protocol: proto ?? 'tcp', host_ip: parts.slice(0, -2).join(':') };
}

/** Environment variable names from a list (`A=b`, `A`) or a map form; never the values. */
function envNames(env) {
  const names = [];
  const literal = [];
  if (Array.isArray(env)) {
    for (const e of env) {
      const s = String(e);
      const eq = s.indexOf('=');
      const name = eq >= 0 ? s.slice(0, eq) : s;
      names.push(name);
      if (eq >= 0 && s.length > eq + 1 && !/^\$\{?[A-Za-z_]/.test(s.slice(eq + 1)) && SECRET_NAME.test(name)) literal.push(name);
    }
  } else if (isObj(env)) {
    for (const [k, v] of Object.entries(env)) {
      names.push(k);
      if (v != null && v !== '' && !/^\$\{?[A-Za-z_]/.test(String(v)) && SECRET_NAME.test(k)) literal.push(k);
    }
  }
  return { names: uniqSorted(names), literal: uniqSorted(literal) };
}

/** @returns {object[]} facts for one Compose file */
export function extractCompose(path, text) {
  const [first] = parseDocs(text);
  const doc = first?.doc;
  if (!isObj(doc) || !isObj(doc.services)) return [];
  const mk = provMaker(path);
  const dir = dirOf(path);
  const facts = [];
  for (const [name, svc] of Object.entries(doc.services)) {
    if (!isObj(svc)) continue;
    const id = `service:compose/${name}`;
    const build = typeof svc.build === 'string' ? { context: svc.build } : isObj(svc.build) ? svc.build : null;
    const ctxDir = build ? resolveRel(dir, asString(build.context) ?? '.') : null;
    const dockerfile = build && ctxDir !== null ? posix.join(ctxDir, asString(build.dockerfile) ?? 'Dockerfile') : null;
    const ports = asArray(svc.ports).map(parsePort);
    const depends = Array.isArray(svc.depends_on) ? svc.depends_on.map(String) : isObj(svc.depends_on) ? Object.keys(svc.depends_on) : [];
    const vols = asArray(svc.volumes).map((v) => (isObj(v) ? { type: v.type, source: asString(v.source) } : { source: String(v).split(':')[0], type: null }));
    const isBind = (v) => v.type === 'bind' || (v.type == null && /^(\/|\.|~)/.test(v.source ?? ''));
    const env = envNames(svc.environment);
    const envFiles = asArray(typeof svc.env_file === 'string' ? [svc.env_file] : svc.env_file).map((f) => (isObj(f) ? asString(f.path) : String(f))).filter(Boolean);
    const healthcheck = isObj(svc.healthcheck) && svc.healthcheck.disable !== true;
    facts.push(nodeFact('service', `compose/${name}`, {
      name,
      path,
      attrs: {
        deployable: true, runtime: 'compose', file: path, image: asString(svc.image),
        build_context: ctxDir, dockerfile, built_image: dockerfile ? `image:${dockerfile}` : null,
        ports_published: ports.filter((p) => p.published != null),
        ports_exposed: uniqSorted(asArray(svc.expose).map(String)),
        publicly_published: ports.some((p) => p.published != null && (p.host_ip == null || p.host_ip === '0.0.0.0' || p.host_ip === '')),
        depends_on: depends.sort(),
        volumes: {
          bind_mounts: vols.filter(isBind).map((v) => v.source).filter(Boolean).sort(),
          named: uniqSorted(vols.filter((v) => !isBind(v)).map((v) => v.source)),
          docker_socket: vols.some((v) => /docker\.sock$/.test(v.source ?? '')),
        },
        privileged: svc.privileged === true,
        network_mode_host: svc.network_mode === 'host',
        pid_host: svc.pid === 'host',
        cap_add: uniqSorted(asArray(svc.cap_add).map(String)),
        user: asString(svc.user),
        read_only: svc.read_only === true,
        env_files: envFiles.sort(),
        env_names: env.names,
        literal_secret_env: env.literal,
        healthcheck,
        restart: asString(svc.restart),
        profiles: uniqSorted(asArray(svc.profiles).map(String)),
      },
    }, mk(1)));
    for (const d of depends) facts.push(edgeFact('DEPENDS_ON', id, `service:compose/${d}`, { via: 'depends_on' }, mk(1)));
    if (ctxDir !== null) {
      facts.push(nodeFact('build_target', ctxDir, { name: ctxDir, path, attrs: { has_build_context: true } }, mk(1)));
      facts.push(edgeFact('DEPENDS_ON', id, `build_target:${ctxDir}`, { via: 'build' }, mk(1)));
    }
  }
  return facts;
}
