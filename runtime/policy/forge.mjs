// Forge approvals (#152; docs/forge-approvals.md controls 2, 3, 4 and 6), GitHub only. With
// `approvals.via: forge | both`, an APPROVED pull request review counts toward a slice's change
// approval when it is on the pull request's current head, that head's diff hashes to the bound
// diff, the binding Unknot posted still matches, and the reviewer holds the role under GitHub's
// own rules. Everything here fails closed: a malformed response, an unknown head or any API error
// counts nothing.
//
// Unknot only reads reviews (FR-003) and only uses a review's id, state, author and commit; review
// and comment text is never read. Every call runs the gh binary at a fixed path (never one found
// on PATH, where an agent could plant a shim) as `gh api --hostname github.com`, so gh's
// credentials go to api.github.com and nowhere else. Who the agents are is configuration a person
// accepted (`approvals.forge.agent_accounts`, numeric ids), never whatever account gh holds now.

import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { parseCodeowners } from '../../adapters/ownership/codeowners.mjs';
import { git } from '../apply/git.mjs';
import { canonicalJSON, digest, sha256 } from '../core/canonical.mjs';
import { UnknotError } from '../core/errors.mjs';
import { matcher } from '../core/glob.mjs';
import { auditPrivateKey, auditPublicKeyPem, signText, verifyText } from '../core/keys.mjs';
import { appendEvent } from '../state/ledger.mjs';
import { ANY_APPROVER, bindingStaleReasons } from './approvals.mjs';

const HOST = 'github.com';
const SHA = /^[0-9a-f]{40}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_URL = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:\/pull\/(\d{1,9}))?\/?$/;
const DECISIVE = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const CODEOWNERS_FILES = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
// Where package managers install gh. PATH is never searched.
const GH_PATHS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/home/linuxbrew/.linuxbrew/bin/gh', '/snap/bin/gh'];
// Settings that could send a gh call elsewhere, through a proxy or under another CA, or make gh read
// another config. Dropping them is defence in depth: the same OS user can still edit gh's own config.
const GH_ENV_DROP = ['GH_HOST', 'GH_CONFIG_DIR', 'GH_REPO', 'GH_DEBUG', 'GH_PATH', 'XDG_CONFIG_HOME',
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'];
const REPO = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;

const str = (v, re) => typeof v === 'string' && re.test(v);
const id = (v) => Number.isSafeInteger(v) && v > 0;
const fail = (msg) => { throw new UnknotError('UK_TOOL_FAILED', msg); };

export const forgeVia = (config) => config.approvals?.via ?? 'local';

/** The repository forge approvals are pinned to (`approvals.forge.repository`, accepted config), lower-cased, or null. */
export function pinnedRepo(config) {
  const m = REPO.exec(String(config.approvals?.forge?.repository ?? ''));
  return m && m[2] !== '.' && m[2] !== '..' ? { owner: m[1], repo: m[2], slug: `${m[1]}/${m[2]}`.toLowerCase() } : null;
}

/** The pinned repository, or a refusal naming the setting. */
export function requirePinnedRepo(config) {
  return pinnedRepo(config) ?? fail('approvals.forge.repository is not set: name the owner/repo whose pull request reviews count, and accept the config');
}

/** Whether a pull request URL is in the pinned repository. */
export const inPinnedRepo = (config, url) => {
  const pin = pinnedRepo(config);
  const pr = githubRepo(url);
  return Boolean(pin && pr?.number && `${pr.owner}/${pr.repo}`.toLowerCase() === pin.slug);
};

/** `{owner, repo, number}` of a github.com remote or pull request URL; null for anything else. */
export function githubRepo(url) {
  const m = GITHUB_URL.exec(String(url ?? '').trim());
  if (!m || m[2] === '.' || m[2] === '..') return null;
  return { owner: m[1], repo: m[2], number: m[3] ? Number(m[3]) : null };
}

/** The gh binary: `approvals.forge.gh` (an absolute path a person accepted), else the first of GH_PATHS. */
export function ghBinary(config) {
  const set = config.approvals?.forge?.gh;
  for (const p of set ? [set] : GH_PATHS) {
    if (!isAbsolute(p)) continue;
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return fail(set ? `approvals.forge.gh (${set}) is not an executable` : `gh is not installed at ${GH_PATHS.join(', ')}; set approvals.forge.gh to its absolute path`);
}

/** A `gh api` client against github.com for this config. Each call throws on any failure. */
function ghEnv() {
  const env = { ...process.env };
  for (const k of GH_ENV_DROP) delete env[k];
  return env;
}

export function ghClient(config) {
  const gh = ghBinary(config);
  const env = ghEnv();
  return (path, { method = 'GET', fields = {} } = {}) => {
    const args = ['api', '--hostname', HOST, '--method', method, '-H', 'Accept: application/vnd.github+json', path];
    for (const [k, v] of Object.entries(fields)) args.push('-f', `${k}=${v}`);
    const r = spawnSync(gh, args, { encoding: 'utf8', shell: false, env, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0) fail(`gh api ${path} failed: ${(r.stderr || r.error?.message || '').trim().split('\n').slice(-2).join(' ')}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return fail(`gh api ${path} did not return JSON`);
    }
  };
}

const userOf = (u) => (id(u?.id) && str(u?.login, LOGIN) ? { uid: u.id, login: u.login.toLowerCase() } : null);

function readPull(api, { owner, repo, number }) {
  const p = api(`repos/${owner}/${repo}/pulls/${number}`);
  const author = userOf(p?.user);
  if (!str(p?.head?.sha, SHA) || !str(p?.base?.sha, SHA) || !author || typeof p?.head?.ref !== 'string' || typeof p?.base?.ref !== 'string' || typeof p?.state !== 'string') fail(`pull request ${number}: malformed response`);
  return { head: p.head.sha, base: p.base.sha, baseRef: p.base.ref, baseRepo: String(p.base.repo?.full_name ?? '').toLowerCase(), author, state: p.state, ref: p.head.ref, repo: String(p.head.repo?.full_name ?? '').toLowerCase() };
}

function readReviews(api, { owner, repo, number }) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = api(`repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) fail(`pull request ${number}: malformed reviews response`);
    all.push(...batch);
    if (batch.length < 100) return all;
    if (page >= 50) fail(`pull request ${number}: more than 5000 reviews`);
  }
}

/** Only the fields that decide anything, strictly typed; anything else is a malformed review. */
function reviewOf(r) {
  const user = userOf(r?.user);
  if (!id(r?.id) || !user || typeof r?.state !== 'string') return null;
  if (r.state === 'APPROVED' && !str(r.commit_id, SHA)) return null;
  return { id: r.id, ...user, state: r.state, commit: typeof r.commit_id === 'string' ? r.commit_id : null };
}

/** Cached yes/no lookups; any API error means no. */
function lookup(cache, key, fn) {
  if (!cache.has(key)) {
    let ok = false;
    try {
      ok = fn();
    } catch {
      ok = false;
    }
    cache.set(key, ok);
  }
  return cache.get(key);
}

function teamMember(api, cache, team, login) {
  const [org, slug, extra] = team.replace(/^@/, '').split('/');
  if (!str(org, NAME) || !str(slug, NAME) || extra !== undefined) return false;
  return lookup(cache, `team ${team.toLowerCase()} ${login}`, () => api(`orgs/${org}/teams/${slug}/memberships/${login}`)?.state === 'active');
}

/** The CODEOWNERS rules on GitHub at the pull request's base commit (GitHub's own source), or null. */
function remoteCodeowners(api, { owner, repo }, baseSha) {
  for (const file of CODEOWNERS_FILES) {
    let res;
    try {
      res = api(`repos/${owner}/${repo}/contents/${file}?ref=${baseSha}`);
    } catch {
      continue;
    }
    if (res?.encoding !== 'base64' || typeof res?.content !== 'string') return null;
    const attrs = parseCodeowners(file, Buffer.from(res.content, 'base64').toString('utf8'))[0]?.attrs;
    // A rule list cut short could hide the last matching rule: no owners at all.
    return !attrs || attrs.truncated ? null : attrs.rules;
  }
  return null;
}

/** The owner tokens (`@user`, `@org/team`) of each path under `rules`, last match wins. */
export function ownersOf(rules, paths) {
  const tests = (rules ?? []).map((rule) => ({ test: matcher(rule.glob.endsWith('/**') ? [rule.glob] : [rule.glob, `${rule.glob}/**`]), owners: rule.owners }));
  return paths.map((p) => {
    for (let i = tests.length - 1; i >= 0; i--) {
      if (tests[i].test(p)) return tests[i].owners.filter((o) => /^(owner|team):@/.test(o)).map((o) => o.slice(o.indexOf(':') + 1).toLowerCase());
    }
    return [];
  });
}

/** The roles a reviewer holds under `approvals.forge.roles`, plus any-approver when it holds one. */
function rolesOf(user, { roleMap, owners, member }) {
  const roles = Object.entries(roleMap).filter(([, m]) =>
    (m.users ?? []).includes(user.uid)
    || (m.teams ?? []).some((t) => member(t, user.login))
    || (m.codeowners === true && owners.length > 0 && owners.every((list) => list.some((o) => o === `@${user.login}` || (o.includes('/') && member(o, user.login)))))).map(([role]) => role);
  return roles.length ? [...roles, ANY_APPROVER] : [];
}

// The signed statement binds the change and the exact head commit `unknot pr` pushed for it.
const STATEMENT = (binding, head) => canonicalJSON({ binding, head, purpose: 'unknot-forge-binding-v2' });

/**
 * Post the binding comment on a slice's pull request (`unknot pr` with forge approvals): the
 * canonical binding signed with the project audit key. The ledger keeps the copy Unknot checks
 * against; the comment is for the reviewer and is never read back.
 */
export function postBinding(ctx, { config, slice, url, binding, head, actor }) {
  if (!str(head, SHA)) fail(`bad head ${head}`);
  const pr = githubRepo(url);
  if (!inPinnedRepo(config, url)) fail(`${url} is not a pull request in ${requirePinnedRepo(config).slug} (approvals.forge.repository); no binding posted`);
  const signature = signText(auditPrivateKey(ctx.projectId), STATEMENT(binding, head));
  const body = [
    `**Unknot approval binding** for \`${slice.id}\`, stage \`${binding.stage}\`.`,
    '',
    `An approving review by a reviewer with the required role, on head \`${head}\` (whose diff hashes to \`diff_hash\`), approves exactly this change. Any other head, including a force-push, a changed plan or policy, or expiry makes it stale. Unknot reads only each review's state, author and commit, never review or comment text.`,
    '',
    '```json',
    JSON.stringify({ binding, head, signature }, null, 2),
    '```',
  ].join('\n');
  const comment = ghClient(config)(`repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`, { method: 'POST', fields: { body } });
  appendEvent(ctx, { type: 'forge.binding_posted', slice_id: slice.id, campaign_id: slice.campaign_id, actor, payload: { url, comment_id: id(comment?.id) ? comment.id : null, binding, head, binding_hash: digest(binding), signature } });
}

function latestEvent(ctx, type, sliceId) {
  const row = ctx.store.get('SELECT payload FROM events WHERE type = ? AND slice_id = ? ORDER BY seq DESC LIMIT 1', type, sliceId);
  return row ? JSON.parse(row.payload) : null;
}

/** The diff of `head` against the baseline as Unknot hashes it: binary, no drivers, submodules always shown. */
const headDiff = (root, base, head, extra = []) => git(root, ['-c', 'diff.ignoreSubmodules=none', 'diff', '--ignore-submodules=none', '--no-ext-diff', '--no-textconv', ...extra, base, head], { check: false });

/**
 * The pull request and binding `unknot pr` posted for a slice, from the ledger: the recorded pull
 * request is in the pinned repository and the binding verifies against the project audit key and
 * matches the current one. `{error}`, with what was found so far, when any of that fails.
 */
function boundPull(ctx, { config, slice, current }) {
  const pin = pinnedRepo(config);
  if (!pin) return { error: 'approvals.forge.repository is not set: name the owner/repo whose pull request reviews count, and accept the config' };
  const opened = latestEvent(ctx, 'pr.opened', slice.id);
  if (!opened) return { error: `no pull request; run unknot pr ${slice.id}` };
  const url = opened.url;
  const pr = githubRepo(url);
  if (!pr?.number) return { url, error: `${url} is not a github.com pull request` };
  if (!inPinnedRepo(config, url)) return { url, error: `${url} is not in ${pin.slug} (approvals.forge.repository); nothing counts` };
  const posted = latestEvent(ctx, 'forge.binding_posted', slice.id);
  if (!posted || posted.url !== url) return { url, error: `no binding comment on ${url}; run unknot pr ${slice.id}` };
  const binding = posted.binding;
  if (binding?.slice_id !== slice.id || binding?.stage !== current.stage || !str(posted.head, SHA) || !verifyText(auditPublicKeyPem(ctx.projectId), STATEMENT(binding, posted.head), posted.signature)) {
    return { url, error: 'the posted binding does not verify against the project audit key' };
  }
  const found = { url, pr, pin, binding, binding_hash: posted.binding_hash, head: posted.head };
  const stale = bindingStaleReasons(binding, current);
  return stale.length ? { ...found, error: `the posted binding is stale (${stale.join(', ')}); run unknot pr ${slice.id} to post a fresh one` } : found;
}

/**
 * The pull request as GitHub has it, checked against the bound head: open, head `<pinned>:<slice
 * branch>` at exactly the commit `unknot pr` pushed and signed, base the pinned base branch, and
 * the head's diff hashing to the bound diff. `between` runs between two reads of the head, which
 * must agree. `{error}`, with head and base when known, when any of that fails.
 */
function pullAtBoundHead(ctx, api, { config, slice, bound }, between = () => {}) {
  const { pr, pin, binding } = bound;
  const pull = readPull(api, pr);
  between();
  // Read the head again: a push while the reviews were read must not pass for the old head.
  if (readPull(api, pr).head !== pull.head) return { error: 'the pull request head moved while its reviews were read; check again' };
  const out = { pull, head: pull.head };
  if (pull.state !== 'open') return { ...out, error: `the pull request is ${pull.state}` };
  if (pull.ref !== slice.branch || pull.repo !== pin.slug) return { ...out, error: `the pull request head is ${pull.repo}:${pull.ref}, not ${slice.branch} in ${pin.slug}` };
  // The base decides whose CODEOWNERS apply: it must be the pinned repository's protected branch.
  const baseRef = config.approvals?.forge?.base ?? api(`repos/${pin.owner}/${pin.repo}`)?.default_branch;
  out.base = baseRef;
  if (typeof baseRef !== 'string' || pull.baseRepo !== pin.slug || pull.baseRef !== baseRef) return { ...out, error: `the pull request base is ${pull.baseRepo}:${pull.baseRef}, not ${pin.slug}:${baseRef}; nothing counts` };
  // The head must be the one `unknot pr` pushed and signed; any other push needs a new binding.
  if (pull.head !== bound.head) return { ...out, error: `the pull request head ${pull.head.slice(0, 12)} is not the bound head ${bound.head.slice(0, 12)} that unknot pr pushed; run unknot pr ${slice.id} to bind the new head` };
  const diff = headDiff(ctx.root, slice.baseline_commit, pull.head, ['--binary', '--full-index']);
  if (diff.status !== 0) return { ...out, error: `head ${pull.head} is not in this repository; git fetch the ${slice.branch} branch and check again` };
  if (`sha256:${sha256(diff.stdout)}` !== binding.diff_hash) return { ...out, error: `the diff of head ${pull.head.slice(0, 12)} against the baseline does not hash to the bound ${binding.diff_hash}` };
  return out;
}

/**
 * The forge approvals of a slice's change stage. Pure: it reads GitHub and records nothing (the
 * ledger records counted reviews when a person accepts, see recordForgeApprovals). `local` are the
 * valid local approvals of the same binding, which a review from an agent account needs
 * (maintainer decision 1).
 * @returns {{valid: object[], reviews: object[], url: string|null, head: string|null, binding: object|null, binding_hash: string|null, error: string|null}}
 */
export function forgeApprovals(ctx, { config, slice, current, local }) {
  const out = { valid: [], reviews: [], url: null, head: null, base: null, binding: null, binding_hash: null, error: null };
  try {
    const agents = config.approvals?.forge?.agent_accounts;
    if (!Array.isArray(agents) || !agents.every(id)) return { ...out, error: 'approvals.forge.agent_accounts is not set: list the numeric GitHub user ids agents act as ([] for none) and accept the config' };
    const bound = boundPull(ctx, { config, slice, current });
    Object.assign(out, { url: bound.url ?? null, binding: bound.binding ?? null, binding_hash: bound.binding_hash ?? null });
    if (bound.error) return { ...out, error: bound.error };
    const { pr } = bound;

    const api = ghClient(config);
    const raw = [];
    const at = pullAtBoundHead(ctx, api, { config, slice, bound }, () => raw.push(...readReviews(api, pr)));
    Object.assign(out, { head: at.head ?? null, base: at.base ?? null });
    if (at.error) return { ...out, error: at.error };
    const { pull } = at;

    const paths = headDiff(ctx.root, slice.baseline_commit, pull.head, ['--name-only', '--no-renames']).stdout.split('\n').filter(Boolean);
    const cache = new Map();
    const ctxRoles = { roleMap: config.approvals?.forge?.roles ?? {}, owners: ownersOf(remoteCodeowners(api, pr, pull.base), paths), member: (t, l) => teamMember(api, cache, t, l) };
    const canWrite = (login) => lookup(cache, `write ${login}`, () => ['admin', 'write'].includes(api(`repos/${pr.owner}/${pr.repo}/collaborators/${login}/permission`)?.permission));
    // The roles each agent account's linked approver signed locally for this binding.
    const signed = new Map();
    for (const v of local) {
      const uid = config.approvers?.[v.approver]?.github_id;
      if (id(uid)) signed.set(uid, new Set([...(signed.get(uid) ?? []), v.role]));
    }

    // Each reviewer's latest decisive review (ids increase over time) is the one that stands.
    const latest = new Map();
    for (const r of raw) {
      const review = reviewOf(r);
      if (!review) {
        out.reviews.push({ id: id(r?.id) ? r.id : null, login: null, counted: false, reasons: ['malformed review'], roles: [] });
        continue;
      }
      if (!DECISIVE.has(review.state)) continue;
      const prev = latest.get(review.uid);
      if (!prev || review.id > prev.id) latest.set(review.uid, review);
    }
    for (const review of [...latest.values()].sort((a, b) => a.id - b.id)) {
      const reasons = [];
      if (review.state !== 'APPROVED') reasons.push(`latest review is ${review.state.toLowerCase()}`);
      else if (review.commit !== pull.head) reasons.push(`approved ${review.commit.slice(0, 12)}, not the head`);
      if (review.uid === pull.author.uid) reasons.push('pull request author');
      const agent = agents.includes(review.uid);
      if (!reasons.length && agent && !signed.has(review.uid)) reasons.push('an agent account (approvals.forge.agent_accounts); counts only with the linked approver\'s local signature for this binding');
      if (!reasons.length && !canWrite(review.login)) reasons.push('no write access to the repository');
      let roles = reasons.length ? [] : rolesOf(review, ctxRoles);
      // An agent account's review counts only for the roles its person signed locally, as in local mode.
      if (agent && roles.length) {
        roles = roles.filter((r) => r !== ANY_APPROVER && signed.get(review.uid).has(r));
        if (roles.length) roles.push(ANY_APPROVER);
      }
      if (!reasons.length && !roles.length) reasons.push('holds no mapped role');
      out.reviews.push({ id: review.id, login: review.login, uid: review.uid, counted: !reasons.length, reasons, roles });
      if (reasons.length) continue;
      for (const role of roles) out.valid.push({ id: `RV-${review.id}`, role, approver: `github:${review.uid}`, login: review.login, via: 'forge', review_id: review.id, head: pull.head });
    }
  } catch (err) {
    return { ...out, valid: [], error: err.message };
  }
  return out;
}

/** The ledger's `approval.recorded` for each counted review, once per review and binding. Called on acceptance. */
export function recordForgeApprovals(ctx, slice, forge) {
  if (!forge?.valid.length) return;
  const seen = new Set(ctx.store.all("SELECT payload FROM events WHERE type = 'approval.recorded' AND slice_id = ?", slice.id)
    .map((e) => JSON.parse(e.payload)).filter((p) => p.via === 'forge').map((p) => `${p.review_id} ${p.binding_hash}`));
  for (const review of forge.reviews.filter((r) => r.counted)) {
    if (seen.has(`${review.id} ${forge.binding_hash}`)) continue;
    appendEvent(ctx, {
      type: 'approval.recorded',
      slice_id: slice.id,
      campaign_id: slice.campaign_id,
      actor: `human:github:${review.login}`,
      payload: { via: 'forge', approval_id: `RV-${review.id}`, review_id: review.id, reviewer: review.login, reviewer_id: review.uid, head: forge.head, pull_request: forge.url, stage: forge.binding.stage, roles: review.roles.filter((r) => r !== ANY_APPROVER), binding: forge.binding, binding_hash: forge.binding_hash },
    });
  }
}

/** What a person accepts on when forge reviews complete a stage: the pull request, its base and head, and who counted as what. */
export function describeForge(forge) {
  const counted = (forge?.reviews ?? []).filter((r) => r.counted).map((r) => `${r.login} (${r.roles.filter((x) => x !== ANY_APPROVER).join(', ') || ANY_APPROVER})`);
  return counted.length ? `pull request ${forge.url} (base ${forge.base}, head ${forge.head}) approved by ${counted.join(', ')}` : null;
}

/**
 * Fold forge approvals into a local approval status (`approvals.via`, change stage only). With
 * `forge` only forge reviews count; with `both` either does, and min_approvers counts people within
 * one channel (a local approver and a reviewer may be the same person).
 */
export function withForge(ctx, status, { config, slice, current }) {
  const via = forgeVia(config);
  if (via === 'local' || current.stage !== 'change') return status;
  const forge = forgeApprovals(ctx, { config, slice, current, local: status.valid });
  const valid = via === 'forge' ? forge.valid : [...status.valid, ...forge.valid];
  const covered = new Set(valid.map((v) => v.role));
  const missing = status.needed.roles.filter((role) => !covered.has(role));
  const forgePeople = new Set(forge.valid.map((v) => v.approver)).size;
  const people = via === 'forge' ? forgePeople : Math.max(status.approvers, forgePeople);
  return { ...status, satisfied: missing.length === 0 && people >= status.needed.min_approvers, valid, missing_roles: missing, approvers: people, forge };
}

// Attested CI evidence (#153; control 5). The pinned evidence workflow is the reusable workflow
// `owner/repo/.github/workflows/<file>@<commit>`, by SHA, so the attestation's signer is exact code.
const CI_WORKFLOW = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/(\.github\/workflows\/[A-Za-z0-9._-]{1,100}\.ya?ml)@([0-9a-f]{40})$/;
const RUN_URI = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\/actions\/runs\/(\d{1,20})\/attempts\/(\d{1,5})$/;
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
/** The required check the reusable workflow reports, for a caller job named `unknot`. */
export const CI_CHECK = 'unknot / verify';
export const CI_ARTIFACT = 'unknot-evidence';
export const CI_FILE = 'unknot-evidence.json';
const CI_MAX_BYTES = 8 * 1024 * 1024;

/** The pinned evidence workflow (`approvals.forge.ci_workflow`, accepted config), or null. */
export function ciWorkflowPin(config) {
  const m = CI_WORKFLOW.exec(String(config.approvals?.forge?.ci_workflow ?? ''));
  if (!m || m[2] === '.' || m[2] === '..') return null;
  return { signer: `${m[1]}/${m[2]}/${m[3]}`, sha: m[4], identity: `https://github.com/${m[1]}/${m[2]}/${m[3]}@${m[4]}`.toLowerCase() };
}

/** Why a verified attestation's certificate is not the pinned workflow's run on the bound head; null when it is. */
function certProblem(cert, { pin, wf, head, branch }) {
  const lc = (v) => String(v ?? '').toLowerCase();
  if (cert?.issuer !== OIDC_ISSUER) return `issued by ${cert?.issuer}, not GitHub Actions`;
  if (lc(cert.sourceRepositoryURI) !== `https://github.com/${pin.slug}`) return `made in ${cert.sourceRepositoryURI}, not ${pin.slug}`;
  if (lc(cert.subjectAlternativeName) !== wf.identity || lc(cert.buildSignerURI) !== wf.identity || cert.buildSignerDigest !== wf.sha) return `signed by ${cert.subjectAlternativeName}, not the pinned workflow ${wf.identity}`;
  if (cert.sourceRepositoryDigest !== head || cert.buildConfigDigest !== head) return `made on commit ${String(cert.sourceRepositoryDigest).slice(0, 12)}, not the bound head ${head.slice(0, 12)}`;
  if (cert.sourceRepositoryRef !== `refs/heads/${branch}`) return `made on ${cert.sourceRepositoryRef}, not refs/heads/${branch}`;
  // Only a push to the slice branch in the pinned repository: never pull_request_target, a fork's pull request or a dispatch.
  if (cert.buildTrigger !== 'push' || cert.githubWorkflowTrigger !== 'push') return `triggered by ${cert.buildTrigger}, not a push`;
  if (cert.runnerEnvironment !== 'github-hosted') return `ran on a ${cert.runnerEnvironment} runner, not a GitHub-hosted one`;
  const run = RUN_URI.exec(String(cert.runInvocationURI ?? ''));
  if (!run || lc(run[1]) !== pin.slug) return `run ${cert.runInvocationURI} is not in ${pin.slug}`;
  return null;
}

/**
 * Attested CI evidence for a slice (control 5). Fails closed: the evidence counts only when the
 * latest run of the caller workflow on the bound head uploaded it, `gh attestation verify` verifies
 * it against Sigstore and GitHub's OIDC identity for the pinned repository, the pinned workflow at
 * its pinned commit, the bound head and the slice branch, Unknot re-checks each certificate field
 * itself, the run was a push on a GitHub-hosted runner, and the head's `.github/workflows` is the
 * base branch's on GitHub (so neither the pull request nor a local baseline commit changed what ran).
 * @returns {{evidence?: object, run?: string, workflow?: string, digest?: string, bytes?: Buffer, head?: string, url?: string, error?: string}}
 */
export function ciEvidence(ctx, { config, slice, current }) {
  let tmp = null;
  try {
    const wf = ciWorkflowPin(config);
    if (!wf) return { error: 'approvals.forge.ci_workflow is not set: name the evidence workflow as owner/repo/.github/workflows/<file>@<commit sha>, and accept the config' };
    const bound = boundPull(ctx, { config, slice, current });
    if (bound.error) return { error: bound.error };
    const { pin } = bound;
    const api = ghClient(config);
    const at = pullAtBoundHead(ctx, api, { config, slice, bound });
    if (at.error) return { error: at.error };
    const head = at.head;
    const { url } = bound;

    // What ran on the push is the head's workflows: they must be the base branch's own, on GitHub.
    const local = git(ctx.root, ['rev-parse', '--verify', '--quiet', `${head}:.github/workflows`], { check: false }).stdout.trim() || null;
    const listing = api(`repos/${pin.owner}/${pin.repo}/contents/.github?ref=${at.pull.base}`);
    const remote = Array.isArray(listing) ? listing.find((e) => e?.name === 'workflows' && e?.type === 'dir')?.sha ?? null : fail('.github on the base branch: malformed response');
    if (local !== remote) return { error: `the head's .github/workflows (${local?.slice(0, 12) ?? 'none'}) is not the base branch's (${remote?.slice(0, 12) ?? 'none'}): a changed workflow ran, so no CI evidence counts` };

    const runsRes = api(`repos/${pin.owner}/${pin.repo}/actions/runs?head_sha=${head}&event=push&per_page=100`);
    if (!Array.isArray(runsRes?.workflow_runs)) fail('workflow runs: malformed response');
    const runs = runsRes.workflow_runs.filter((r) => id(r?.id) && r.head_sha === head && r.event === 'push' && String(r.head_repository?.full_name).toLowerCase() === pin.slug && typeof r.path === 'string' && id(r.run_attempt)).sort((a, b) => b.id - a.id);
    const run = runs.find((r) => {
      const arts = api(`repos/${pin.owner}/${pin.repo}/actions/runs/${r.id}/artifacts?name=${CI_ARTIFACT}`)?.artifacts;
      return Array.isArray(arts) && arts.some((a) => a?.name === CI_ARTIFACT && a?.expired === false);
    });
    if (!run) return { error: `no push run on head ${head.slice(0, 12)} uploaded ${CI_ARTIFACT}; is the evidence workflow installed (docs/forge-approvals.md)?` };

    tmp = mkdtempSync(join(tmpdir(), 'unknot-ci-'));
    const gh = ghBinary(config);
    const env = ghEnv();
    const dl = spawnSync(gh, ['run', 'download', String(run.id), '--name', CI_ARTIFACT, '--dir', tmp, '--repo', `${HOST}/${pin.owner}/${pin.repo}`], { encoding: 'utf8', shell: false, env, timeout: 120_000 });
    if (dl.status !== 0) fail(`gh run download ${run.id} failed: ${(dl.stderr || dl.error?.message || '').trim().split('\n').slice(-2).join(' ')}`);
    const file = join(tmp, CI_FILE);
    if (!existsSync(file) || statSync(file).size > CI_MAX_BYTES) return { error: `run ${run.id}: ${CI_ARTIFACT} has no ${CI_FILE} of at most ${CI_MAX_BYTES} bytes` };
    const bytes = readFileSync(file);
    const fileDigest = sha256(bytes);

    // gh checks the Sigstore signature, the transparency log and the identity flags; the fields are checked again below.
    const v = spawnSync(gh, ['attestation', 'verify', file, '--hostname', HOST, '--repo', `${pin.owner}/${pin.repo}`, '--signer-workflow', wf.signer, '--signer-digest', wf.sha,
      '--source-digest', head, '--source-ref', `refs/heads/${slice.branch}`, '--cert-oidc-issuer', OIDC_ISSUER, '--deny-self-hosted-runners', '--format=json'], { encoding: 'utf8', shell: false, env, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
    if (v.status !== 0) return { error: `the evidence of run ${run.id} has no valid attestation from ${wf.signer}@${wf.sha.slice(0, 12)} on head ${head.slice(0, 12)}: ${(v.stderr || v.error?.message || '').trim().split('\n').slice(-1)[0]}` };
    let verified;
    try {
      verified = JSON.parse(v.stdout);
    } catch {
      verified = null;
    }
    if (!Array.isArray(verified) || !verified.length) return { error: `gh attestation verify for run ${run.id} returned no verified attestation` };
    const want = `https://github.com/${pin.slug}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
    const problems = [];
    for (const entry of verified) {
      const cert = entry?.verificationResult?.signature?.certificate;
      const subjects = entry?.verificationResult?.statement?.subject;
      const problem = certProblem(cert, { pin, wf, head, branch: slice.branch })
        ?? (Array.isArray(subjects) && subjects.some((s) => s?.digest?.sha256 === fileDigest) ? null : 'its subject is not this evidence file')
        // Only the latest run and attempt of the workflow counts: an older run's attestation is a replay.
        ?? (String(cert.runInvocationURI).toLowerCase() === want.toLowerCase() ? null : `it is from ${cert.runInvocationURI}, not the latest run ${want}`);
      if (problem) {
        problems.push(problem);
        continue;
      }
      const caller = String(cert.buildConfigURI ?? '').slice(`https://github.com/${pin.slug}/`.length).split('@')[0];
      const newer = runs.find((r) => r.path === caller && r.id > run.id);
      if (newer || run.path !== caller) return { error: `run ${newer?.id ?? run.id} of ${caller} on head ${head.slice(0, 12)} is newer than the attested evidence (or not that workflow's); only the latest run counts` };
      if (run.status !== 'completed') return { error: `run ${run.id} has not completed` };
      let evidence;
      try {
        evidence = JSON.parse(bytes.toString('utf8'));
      } catch {
        return { error: `run ${run.id}: ${CI_FILE} is not JSON` };
      }
      const e = evidence;
      if (e?.schema !== 'unknot-ci-evidence-v1' || e.head !== head || e.slice_id !== slice.id || e.diff_hash !== bound.binding.diff_hash || String(e.repository).toLowerCase() !== pin.slug
        || e.run_id !== run.id || e.run_attempt !== run.run_attempt || !Array.isArray(e.results)) {
        return { error: `run ${run.id}: the evidence is not for ${slice.id} at head ${head.slice(0, 12)} with the bound diff in that run` };
      }
      return { evidence, run: want, conclusion: run.conclusion, workflow: wf.identity, digest: `sha256:${fileDigest}`, bytes, head, url };
    }
    return { error: `no attestation of run ${run.id}'s evidence counts: ${[...new Set(problems)].join('; ')}` };
  } catch (err) {
    return { error: err.message };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/** The first of `file` and its parent directories that the current user can write, or null. */
function writableOnPath(file) {
  for (let p = file; ; p = dirname(p)) {
    try {
      accessSync(p, constants.W_OK);
      return p;
    } catch {
      // not writable
    }
    if (dirname(p) === p) return null;
  }
}

/** Doctor checks for forge approvals (control 6): gh, base branch protection, and the agent accounts' push. */
export function forgeChecks(root, config) {
  if (forgeVia(config) === 'local') return [];
  const checks = [];
  const add = (name, level, detail) => checks.push({ name, level, detail });
  try {
    const remotes = git(root, ['remote']).stdout.split('\n').filter(Boolean);
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    const repo = remote ? githubRepo(git(root, ['remote', 'get-url', remote]).stdout) : null;
    if (!repo) {
      add('forge remote', 'fail', `approvals.via is ${forgeVia(config)} but ${remote ? `remote ${remote} is not on github.com` : 'there is no git remote'}; forge approvals are GitHub only`);
      return checks;
    }
    const pin = pinnedRepo(config);
    if (!pin) {
      add('forge repository', 'fail', `approvals.forge.repository is not set, so no review counts; set it to ${repo.owner}/${repo.repo} and accept the config`);
      return checks;
    }
    const remoteSlug = `${repo.owner}/${repo.repo}`.toLowerCase();
    add('forge repository', remoteSlug === pin.slug ? 'ok' : 'fail', remoteSlug === pin.slug ? pin.slug : `remote ${remote} is ${remoteSlug}, not the pinned ${pin.slug}; pull requests there never count`);
    const agents = config.approvals?.forge?.agent_accounts;
    if (!Array.isArray(agents)) add('forge agents', 'fail', 'approvals.forge.agent_accounts is not set, so no review counts: list the numeric GitHub user ids agents act as (gh api user --jq .id), or [] for none');
    const api = ghClient(config);
    const bin = ghBinary(config);
    const writable = writableOnPath(bin);
    add('forge gh', writable ? 'warn' : 'ok', writable ? `${bin}: ${writable} is writable by ${userInfo().username}, so an agent running as this user could replace gh; install gh where only root can write, or run agents as another user` : bin);
    const slug = pin.slug;
    const base = config.approvals?.forge?.base ?? api(`repos/${slug}`)?.default_branch;
    if (typeof base !== 'string' || !base) fail(`repos/${slug}: no default branch`);
    let prot = null;
    try {
      prot = api(`repos/${slug}/branches/${encodeURIComponent(base)}/protection`);
    } catch {
      prot = null;
    }
    const reviews = prot?.required_pull_request_reviews ?? null;
    add('forge reviews', reviews ? 'ok' : 'fail', reviews
      ? `${slug} ${base} requires ${reviews.required_approving_review_count ?? 1} approving review(s)`
      : `${slug} ${base} has no branch protection requiring pull request reviews (or gh cannot read it); set it under Settings > Branches`);
    add('forge code owners', reviews?.require_code_owner_reviews === true ? 'ok' : 'fail', reviews?.require_code_owner_reviews === true
      ? `${base} requires a code owner's review`
      : `${base} does not require review from code owners; turn on "Require review from Code Owners"`);
    if (config.approvals?.forge?.ci_workflow !== undefined) {
      const wf = ciWorkflowPin(config);
      const sc = prot?.required_status_checks;
      const required = [...(sc?.contexts ?? []), ...(sc?.checks ?? []).map((c) => c?.context)].includes(CI_CHECK);
      add('forge ci check', wf && required ? 'ok' : 'fail', !wf
        ? 'approvals.forge.ci_workflow is not owner/repo/.github/workflows/<file>@<commit sha>; the evidence workflow must be pinned by SHA'
        : required ? `${base} requires the ${CI_CHECK} check from ${wf.signer}@${wf.sha.slice(0, 12)}` : `${base} does not require the status check "${CI_CHECK}", so a pull request can merge with it failing or missing; add it under Settings > Branches`);
    }
    for (const uid of Array.isArray(agents) ? agents : []) {
      let login = null;
      let permission = null;
      try {
        login = userOf(api(`user/${uid}`))?.login ?? null;
        permission = login ? api(`repos/${slug}/collaborators/${login}/permission`)?.permission ?? null : null;
      } catch {
        // unknown: judged as able to push below unless protection says otherwise
      }
      const bypass = (reviews?.bypass_pull_request_allowances?.users ?? []).some((u) => u?.id === uid);
      const canPush = !reviews || bypass || (permission === 'admin' && prot?.enforce_admins?.enabled !== true);
      add('forge agent push', canPush ? 'fail' : 'ok', canPush
        ? `agent account ${login ?? uid} can push to ${base} without a review${bypass ? ' (review bypass allowance)' : permission === 'admin' ? ' (admin, and admins are not included)' : ''}; run agents under another account or tighten protection`
        : `agent account ${login ?? uid} cannot push to ${base} without a review`);
    }
  } catch (err) {
    add('forge', 'fail', `${err.message}`);
  }
  return checks;
}
