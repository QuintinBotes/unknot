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
import { accessSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
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
// gh settings that could send a call elsewhere or change what it reads; the rest of the env stays.
const GH_ENV_DROP = ['GH_HOST', 'GH_CONFIG_DIR', 'GH_REPO', 'GH_DEBUG', 'GH_PATH'];

const str = (v, re) => typeof v === 'string' && re.test(v);
const id = (v) => Number.isSafeInteger(v) && v > 0;
const fail = (msg) => { throw new UnknotError('UK_TOOL_FAILED', msg); };

export const forgeVia = (config) => config.approvals?.via ?? 'local';

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
export function ghClient(config) {
  const gh = ghBinary(config);
  const env = { ...process.env };
  for (const k of GH_ENV_DROP) delete env[k];
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
  if (!str(p?.head?.sha, SHA) || !str(p?.base?.sha, SHA) || !author || typeof p?.head?.ref !== 'string' || typeof p?.state !== 'string') fail(`pull request ${number}: malformed response`);
  return { head: p.head.sha, base: p.base.sha, author, state: p.state, ref: p.head.ref, repo: String(p.head.repo?.full_name ?? '').toLowerCase() };
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

const STATEMENT = (binding) => canonicalJSON({ binding, purpose: 'unknot-forge-binding-v1' });

/**
 * Post the binding comment on a slice's pull request (`unknot pr` with forge approvals): the
 * canonical binding signed with the project audit key. The ledger keeps the copy Unknot checks
 * against; the comment is for the reviewer and is never read back.
 */
export function postBinding(ctx, { config, slice, url, binding, actor }) {
  const pr = githubRepo(url);
  if (!pr?.number) fail(`${url} is not a github.com pull request; forge approvals are GitHub only`);
  const signature = signText(auditPrivateKey(ctx.projectId), STATEMENT(binding));
  const body = [
    `**Unknot approval binding** for \`${slice.id}\`, stage \`${binding.stage}\`.`,
    '',
    'An approving review by a reviewer with the required role, on the head commit whose diff hashes to `diff_hash`, approves exactly this change. A new push, a changed plan or policy, or expiry makes it stale. Unknot reads only each review\'s state, author and commit, never review or comment text.',
    '',
    '```json',
    JSON.stringify({ binding, signature }, null, 2),
    '```',
  ].join('\n');
  const comment = ghClient(config)(`repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`, { method: 'POST', fields: { body } });
  appendEvent(ctx, { type: 'forge.binding_posted', slice_id: slice.id, campaign_id: slice.campaign_id, actor, payload: { url, comment_id: id(comment?.id) ? comment.id : null, binding, binding_hash: digest(binding), signature } });
}

function latestEvent(ctx, type, sliceId) {
  const row = ctx.store.get('SELECT payload FROM events WHERE type = ? AND slice_id = ? ORDER BY seq DESC LIMIT 1', type, sliceId);
  return row ? JSON.parse(row.payload) : null;
}

/** The diff of `head` against the baseline as Unknot hashes it: binary, no drivers, submodules always shown. */
const headDiff = (root, base, head, extra = []) => git(root, ['-c', 'diff.ignoreSubmodules=none', 'diff', '--ignore-submodules=none', '--no-ext-diff', '--no-textconv', ...extra, base, head], { check: false });

/**
 * The forge approvals of a slice's change stage. Pure: it reads GitHub and records nothing (the
 * ledger records counted reviews when a person accepts, see recordForgeApprovals). `local` are the
 * valid local approvals of the same binding, which a review from an agent account needs
 * (maintainer decision 1).
 * @returns {{valid: object[], reviews: object[], url: string|null, head: string|null, binding: object|null, binding_hash: string|null, error: string|null}}
 */
export function forgeApprovals(ctx, { config, slice, current, local }) {
  const out = { valid: [], reviews: [], url: null, head: null, binding: null, binding_hash: null, error: null };
  try {
    const agents = config.approvals?.forge?.agent_accounts;
    if (!Array.isArray(agents) || !agents.every(id)) return { ...out, error: 'approvals.forge.agent_accounts is not set: list the numeric GitHub user ids agents act as ([] for none) and accept the config' };
    const opened = latestEvent(ctx, 'pr.opened', slice.id);
    if (!opened) return { ...out, error: `no pull request; run unknot pr ${slice.id}` };
    out.url = opened.url;
    const pr = githubRepo(opened.url);
    if (!pr?.number) return { ...out, error: `${opened.url} is not a github.com pull request` };
    const posted = latestEvent(ctx, 'forge.binding_posted', slice.id);
    if (!posted || posted.url !== opened.url) return { ...out, error: `no binding comment on ${opened.url}; run unknot pr ${slice.id}` };
    const binding = posted.binding;
    if (binding?.slice_id !== slice.id || binding?.stage !== current.stage || !verifyText(auditPublicKeyPem(ctx.projectId), STATEMENT(binding), posted.signature)) {
      return { ...out, error: 'the posted binding does not verify against the project audit key' };
    }
    out.binding = binding;
    out.binding_hash = posted.binding_hash;
    const stale = bindingStaleReasons(binding, current);
    if (stale.length) return { ...out, error: `the posted binding is stale (${stale.join(', ')}); run unknot pr ${slice.id} to post a fresh one` };

    const api = ghClient(config);
    const pull = readPull(api, pr);
    const raw = readReviews(api, pr);
    // Read the head again: a push while the reviews were read must not pass for the old head.
    if (readPull(api, pr).head !== pull.head) return { ...out, error: 'the pull request head moved while its reviews were read; check again' };
    out.head = pull.head;
    if (pull.state !== 'open') return { ...out, error: `the pull request is ${pull.state}` };
    if (pull.ref !== slice.branch || pull.repo !== `${pr.owner}/${pr.repo}`.toLowerCase()) return { ...out, error: `the pull request head is ${pull.repo}:${pull.ref}, not ${slice.branch} in ${pr.owner}/${pr.repo}` };

    const diff = headDiff(ctx.root, slice.baseline_commit, pull.head, ['--binary', '--full-index']);
    if (diff.status !== 0) return { ...out, error: `head ${pull.head} is not in this repository; git fetch the ${slice.branch} branch and check again` };
    if (`sha256:${sha256(diff.stdout)}` !== binding.diff_hash) return { ...out, error: `the diff of head ${pull.head.slice(0, 12)} against the baseline does not hash to the bound ${binding.diff_hash}` };

    const paths = headDiff(ctx.root, slice.baseline_commit, pull.head, ['--name-only', '--no-renames']).stdout.split('\n').filter(Boolean);
    const cache = new Map();
    const ctxRoles = { roleMap: config.approvals?.forge?.roles ?? {}, owners: ownersOf(remoteCodeowners(api, pr, pull.base), paths), member: (t, l) => teamMember(api, cache, t, l) };
    const canWrite = (login) => lookup(cache, `write ${login}`, () => ['admin', 'write'].includes(api(`repos/${pr.owner}/${pr.repo}/collaborators/${login}/permission`)?.permission));
    const signedBy = new Set(local.map((v) => config.approvers?.[v.approver]?.github_id).filter(id));

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
      if (!reasons.length && agents.includes(review.uid) && !signedBy.has(review.uid)) reasons.push('an agent account (approvals.forge.agent_accounts); counts only with the linked approver\'s local signature for this binding');
      if (!reasons.length && !canWrite(review.login)) reasons.push('no write access to the repository');
      const roles = reasons.length ? [] : rolesOf(review, ctxRoles);
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
    const agents = config.approvals?.forge?.agent_accounts;
    if (!Array.isArray(agents)) add('forge agents', 'fail', 'approvals.forge.agent_accounts is not set, so no review counts: list the numeric GitHub user ids agents act as (gh api user --jq .id), or [] for none');
    const api = ghClient(config);
    add('forge gh', 'ok', ghBinary(config));
    const slug = `${repo.owner}/${repo.repo}`;
    const base = api(`repos/${slug}`)?.default_branch;
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
