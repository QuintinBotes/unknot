// Forge approvals (#152; docs/forge-approvals.md controls 2, 3, 4 and 6), GitHub only. With
// `approvals.via: forge | both`, an APPROVED pull request review counts toward a slice's change
// approval when it is on the pull request's current head, that head's diff hashes to the bound
// diff, the binding Unknot posted still matches, and the reviewer holds the role. Everything here
// fails closed: a malformed response, an unknown head or any API error counts nothing.
//
// Unknot only reads reviews (FR-003) and only uses a review's id, state, author and commit; review
// and comment text is never read. Every call is `gh api --hostname github.com`, so gh's
// credentials go to api.github.com and nowhere else, whatever GH_HOST or the remote say.

import { spawnSync } from 'node:child_process';
import { parseCodeowners } from '../../adapters/ownership/codeowners.mjs';
import { git } from '../apply/git.mjs';
import { which } from '../broker/broker.mjs';
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

const str = (v, re) => typeof v === 'string' && re.test(v);
const fail = (msg) => { throw new UnknotError('UK_TOOL_FAILED', msg); };

export const forgeVia = (config) => config.approvals?.via ?? 'local';

/** `{owner, repo, number}` of a github.com remote or pull request URL; null for anything else. */
export function githubRepo(url) {
  const m = GITHUB_URL.exec(String(url ?? '').trim());
  if (!m || m[2] === '.' || m[2] === '..') return null;
  return { owner: m[1], repo: m[2], number: m[3] ? Number(m[3]) : null };
}

/** One `gh api` call against github.com, parsed as JSON. Throws on any failure. */
export function ghApi(path, { method = 'GET', fields = {} } = {}) {
  const gh = which('gh');
  if (!gh) fail('gh is not on PATH; forge approvals read GitHub through gh');
  const args = ['api', '--hostname', HOST, '--method', method, '-H', 'Accept: application/vnd.github+json', path];
  for (const [k, v] of Object.entries(fields)) args.push('-f', `${k}=${v}`);
  const r = spawnSync(gh, args, { encoding: 'utf8', shell: false, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) fail(`gh api ${path} failed: ${(r.stderr || r.error?.message || '').trim().split('\n').slice(-2).join(' ')}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    return fail(`gh api ${path} did not return JSON`);
  }
}

/** The login gh acts as (`forge_actor`), lower-cased. */
export function forgeActor() {
  const login = ghApi('user')?.login;
  if (!str(login, LOGIN)) fail('gh api user returned no valid login');
  return login.toLowerCase();
}

function readPull({ owner, repo, number }) {
  const p = ghApi(`repos/${owner}/${repo}/pulls/${number}`);
  if (!str(p?.head?.sha, SHA) || !str(p?.user?.login, LOGIN) || typeof p?.head?.ref !== 'string' || typeof p?.state !== 'string') fail(`pull request ${number}: malformed response`);
  return { head: p.head.sha, author: p.user.login.toLowerCase(), state: p.state, ref: p.head.ref, repo: String(p.head.repo?.full_name ?? '').toLowerCase() };
}

function readReviews({ owner, repo, number }) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = ghApi(`repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) fail(`pull request ${number}: malformed reviews response`);
    all.push(...batch);
    if (batch.length < 100) return all;
    if (page >= 50) fail(`pull request ${number}: more than 5000 reviews`);
  }
}

/** Only the fields that decide anything, strictly typed; anything else is a malformed review. */
function reviewOf(r) {
  if (!Number.isSafeInteger(r?.id) || r.id <= 0 || !str(r?.user?.login, LOGIN) || typeof r?.state !== 'string') return null;
  if (r.state === 'APPROVED' && !str(r.commit_id, SHA)) return null;
  return { id: r.id, login: r.user.login.toLowerCase(), state: r.state, commit: typeof r.commit_id === 'string' ? r.commit_id : null };
}

/** Whether `login` is an active member of team `org/slug` (any error means no). */
function teamMember(cache, team, login) {
  const key = `${team.toLowerCase()} ${login}`;
  if (!cache.has(key)) {
    const [org, slug, extra] = team.replace(/^@/, '').split('/');
    let ok = false;
    if (str(org, NAME) && str(slug, NAME) && extra === undefined) {
      try {
        ok = ghApi(`orgs/${org}/teams/${slug}/memberships/${login}`)?.state === 'active';
      } catch {
        ok = false;
      }
    }
    cache.set(key, ok);
  }
  return cache.get(key);
}

/** The owner tokens (`@user`, `@org/team`) of each path under the CODEOWNERS at `commit`. */
export function codeOwners(root, commit, paths) {
  for (const file of CODEOWNERS_FILES) {
    const r = git(root, ['show', `${commit}:${file}`], { check: false });
    if (r.status !== 0) continue;
    const attrs = parseCodeowners(file, r.stdout)[0]?.attrs;
    // A rule list cut short could hide the last matching rule: no owners at all.
    if (!attrs || attrs.truncated) return paths.map(() => []);
    const rules = attrs.rules.map((rule) => ({ test: matcher(rule.glob.endsWith('/**') ? [rule.glob] : [rule.glob, `${rule.glob}/**`]), owners: rule.owners }));
    return paths.map((p) => {
      for (let i = rules.length - 1; i >= 0; i--) {
        if (rules[i].test(p)) return rules[i].owners.filter((id) => /^(owner|team):@/.test(id)).map((id) => id.slice(id.indexOf(':') + 1).toLowerCase());
      }
      return [];
    });
  }
  return paths.map(() => []);
}

/** The roles `login` holds under `approvals.forge.roles`, plus any-approver when it holds one. */
function rolesOf(login, { roleMap, owners, member }) {
  const roles = Object.entries(roleMap).filter(([, m]) =>
    (m.users ?? []).some((u) => String(u).toLowerCase() === login)
    || (m.teams ?? []).some((t) => member(t, login))
    || (m.codeowners === true && owners.length > 0 && owners.every((list) => list.some((o) => o === `@${login}` || (o.includes('/') && member(o, login)))))).map(([role]) => role);
  return roles.length ? [...roles, ANY_APPROVER] : [];
}

const STATEMENT = (binding) => canonicalJSON({ binding, purpose: 'unknot-forge-binding-v1' });

/**
 * Post the binding comment on a slice's pull request (`unknot pr` with forge approvals): the
 * canonical binding signed with the project audit key. The ledger keeps the copy Unknot checks
 * against; the comment is for the reviewer and is never read back.
 */
export function postBinding(ctx, { slice, url, binding, actor }) {
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
  const comment = ghApi(`repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`, { method: 'POST', fields: { body } });
  appendEvent(ctx, { type: 'forge.binding_posted', slice_id: slice.id, campaign_id: slice.campaign_id, actor, payload: { url, comment_id: Number.isSafeInteger(comment?.id) ? comment.id : null, binding, binding_hash: digest(binding), signature } });
}

function latestEvent(ctx, type, sliceId) {
  const row = ctx.store.get('SELECT payload FROM events WHERE type = ? AND slice_id = ? ORDER BY seq DESC LIMIT 1', type, sliceId);
  return row ? JSON.parse(row.payload) : null;
}

/**
 * The forge approvals of a slice's change stage. `local` are the valid local approvals of the same
 * binding, which a review from the account the agent acts as needs (maintainer decision 1).
 * @returns {{valid: object[], reviews: {id: number|null, login: string|null, counted: boolean, reasons: string[]}[], url: string|null, head: string|null, error: string|null}}
 */
export function forgeApprovals(ctx, { config, slice, current, local }) {
  const out = { valid: [], reviews: [], url: null, head: null, binding_hash: null, error: null };
  try {
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
    out.binding_hash = posted.binding_hash;
    const stale = bindingStaleReasons(binding, current);
    if (stale.length) return { ...out, error: `the posted binding is stale (${stale.join(', ')}); run unknot pr ${slice.id} to post a fresh one` };

    const actor = forgeActor();
    const pull = readPull(pr);
    const raw = readReviews(pr);
    // Read the head again: a push while the reviews were read must not pass for the old head.
    if (readPull(pr).head !== pull.head) return { ...out, error: 'the pull request head moved while its reviews were read; check again' };
    out.head = pull.head;
    if (pull.state !== 'open') return { ...out, error: `the pull request is ${pull.state}` };
    if (pull.ref !== slice.branch || pull.repo !== `${pr.owner}/${pr.repo}`.toLowerCase()) return { ...out, error: `the pull request head is ${pull.repo}:${pull.ref}, not ${slice.branch} in ${pr.owner}/${pr.repo}` };

    const diff = git(ctx.root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--full-index', slice.baseline_commit, pull.head], { check: false });
    if (diff.status !== 0) return { ...out, error: `head ${pull.head} is not in this repository; git fetch the ${slice.branch} branch and check again` };
    if (`sha256:${sha256(diff.stdout)}` !== binding.diff_hash) return { ...out, error: `the diff of head ${pull.head.slice(0, 12)} against the baseline does not hash to the bound ${binding.diff_hash}` };

    const paths = git(ctx.root, ['diff', '--name-only', '--no-renames', slice.baseline_commit, pull.head]).stdout.split('\n').filter(Boolean);
    const cache = new Map();
    const ctxRoles = { roleMap: config.approvals?.forge?.roles ?? {}, owners: codeOwners(ctx.root, slice.baseline_commit, paths), member: (t, l) => teamMember(cache, t, l) };
    const localPeople = new Set(local.map((v) => config.approvers?.[v.approver]?.github?.toLowerCase()).filter(Boolean));

    // Each reviewer's latest decisive review (ids increase over time) is the one that stands.
    const latest = new Map();
    for (const r of raw) {
      const review = reviewOf(r);
      if (!review) {
        out.reviews.push({ id: Number.isSafeInteger(r?.id) ? r.id : null, login: null, counted: false, reasons: ['malformed review'] });
        continue;
      }
      if (!DECISIVE.has(review.state)) continue;
      const prev = latest.get(review.login);
      if (!prev || review.id > prev.id) latest.set(review.login, review);
    }
    for (const review of [...latest.values()].sort((a, b) => a.id - b.id)) {
      const reasons = [];
      if (review.state !== 'APPROVED') reasons.push(`latest review is ${review.state.toLowerCase()}`);
      else if (review.commit !== pull.head) reasons.push(`approved ${review.commit.slice(0, 12)}, not the head`);
      if (review.login === pull.author) reasons.push('pull request author');
      const roles = reasons.length ? [] : rolesOf(review.login, ctxRoles);
      if (!reasons.length && !roles.length) reasons.push('holds no mapped role');
      if (!reasons.length && review.login === actor && !localPeople.has(actor)) reasons.push(`the account the agent acts as (${actor}); counts only with that person's local signature for this binding`);
      out.reviews.push({ id: review.id, login: review.login, counted: !reasons.length, reasons, roles });
      if (reasons.length) continue;
      for (const role of roles) out.valid.push({ id: `RV-${review.id}`, role, approver: `github:${review.login}`, via: 'forge', review_id: review.id, head: pull.head });
      recordReview(ctx, { slice, review, roles, head: pull.head, url: opened.url, binding, binding_hash: posted.binding_hash });
    }
  } catch (err) {
    return { ...out, valid: [], error: err.message };
  }
  return out;
}

/** The ledger's `approval.recorded` for a counted review, once per review and binding. */
function recordReview(ctx, { slice, review, roles, head, url, binding, binding_hash }) {
  const seen = ctx.store.all("SELECT payload FROM events WHERE type = 'approval.recorded' AND slice_id = ?", slice.id)
    .some((e) => { const p = JSON.parse(e.payload); return p.via === 'forge' && p.review_id === review.id && p.binding_hash === binding_hash; });
  if (seen) return;
  appendEvent(ctx, {
    type: 'approval.recorded',
    slice_id: slice.id,
    campaign_id: slice.campaign_id,
    actor: `human:github:${review.login}`,
    payload: { via: 'forge', approval_id: `RV-${review.id}`, review_id: review.id, reviewer: review.login, head, pull_request: url, stage: binding.stage, roles: roles.filter((r) => r !== ANY_APPROVER), binding, binding_hash },
  });
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

/** Doctor checks for forge approvals (control 6): base branch protection and the agent account's push. */
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
    const slug = `${repo.owner}/${repo.repo}`;
    const actor = forgeActor();
    const base = ghApi(`repos/${slug}`)?.default_branch;
    if (typeof base !== 'string' || !base) fail(`repos/${slug}: no default branch`);
    let prot = null;
    try {
      prot = ghApi(`repos/${slug}/branches/${encodeURIComponent(base)}/protection`);
    } catch {
      prot = null;
    }
    const reviews = prot?.required_pull_request_reviews ?? null;
    add('forge reviews', reviews ? 'ok' : 'fail', reviews
      ? `${slug} ${base} requires ${reviews.required_approving_review_count ?? 1} approving review(s)`
      : `${slug} ${base} has no branch protection requiring pull request reviews (or ${actor} cannot read it); set it under Settings > Branches`);
    add('forge code owners', reviews?.require_code_owner_reviews === true ? 'ok' : 'fail', reviews?.require_code_owner_reviews === true
      ? `${base} requires a code owner's review`
      : `${base} does not require review from code owners; turn on "Require review from Code Owners"`);
    let permission = null;
    try {
      permission = ghApi(`repos/${slug}/collaborators/${actor}/permission`)?.permission ?? null;
    } catch {
      permission = null;
    }
    const bypass = (reviews?.bypass_pull_request_allowances?.users ?? []).some((u) => String(u?.login).toLowerCase() === actor);
    const canPush = !reviews || bypass || (permission === 'admin' && prot?.enforce_admins?.enabled !== true);
    add('forge agent push', canPush ? 'warn' : 'ok', canPush
      ? `${actor}, the account gh acts as, can push to ${base} without a review${bypass ? ' (review bypass allowance)' : permission === 'admin' ? ' (admin, and admins are not included)' : ''}; run agents under another account or tighten protection`
      : `${actor} cannot push to ${base} without a review`);
  } catch (err) {
    add('forge', 'fail', `${err.message}`);
  }
  return checks;
}
