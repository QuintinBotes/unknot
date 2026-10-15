# Forge approvals and CI verification (design)

Status: proposed design for roadmap item 4 ([roadmap.md](roadmap.md#4-fit-with-the-governance-teams-already-use)); nothing here is implemented yet. GitHub and GitHub Actions come first; the design keeps a forge interface so GitLab, Bitbucket and Azure DevOps can follow.

## Goal

A campaign can be approved and verified entirely through pull request reviews and CI, with the same guarantees local signatures give today:

- an approval binds the exact change (slice, diff, plan, policy) and goes stale when any of them changes;
- no agent can produce one;
- evidence that a proof obligation passed is checked, not taken on trust;
- the ledger records the same bindings it records today.

Local Ed25519 keys stay, and stay the default: forge approval is opt-in per repository (`approvals.via: local | forge | both`, default `local`), so nothing changes for existing users.

## Threat model

| Threat | Today | With forge approvals |
|---|---|---|
| An agent approves its own work | No TTY, no passphrase, the verb is refused | The agent runs with the person's forge credentials, so a credential alone proves nothing |
| An approval is reused for a different change | Binding digests | Same binding, posted on the pull request and checked against the review's commit |
| Evidence is fabricated | Brokered commands, signed ledger | CI results are only accepted with an attestation from this repository's workflow at that commit |
| Repository text tries to grant authority | Repository text is data | Pull request bodies, comments and review text are data too; only review state, author and commit are read |

## Controls

1. **Agents cannot approve on the forge.** The human-only rule covers every way an agent session could submit an approving review: `gh pr review --approve`, `gh api` calls to the reviews endpoints (REST `POST /repos/{o}/{r}/pulls/{n}/reviews` with `event: APPROVE`, GraphQL `addPullRequestReview`/`submitPullRequestReview` with `APPROVE`), and forge MCP tools that create or submit reviews. Judged on the command that would run, like the rest of the rule.
2. **A review from the agent's own account is never enough on its own.** When a forge approval is checked, Unknot reads the account the agent session can act as (`gh api user`, recorded once per run as `forge_actor`). A review from any other account with the role counts by itself. A review from the agent's account (typically the person's own, when agents use their credentials) counts only together with a local signed approval for the same binding, given by that person at their terminal: the review says the person looked at the change on the forge, the signature proves it was the person and not an agent holding their token. Reviews by the pull request's author never count. Running agents under a separate bot account is supported and documented as an option; it is not required.
3. **The review binds the exact change.** Unknot opens a draft pull request per slice and posts a binding comment: the canonical binding (commit, slice id, version and digest, diff hash, plan and policy digests, stage, expiry), signed with the project audit key. A review counts only when:
   - its state is `APPROVED` and it was submitted on the pull request's current head commit (`commit_id`);
   - the head's diff against the slice baseline hashes to the bound `diff_hash`;
   - the binding comment verifies against the audit key and matches the current binding field by field;
   - the reviewer holds the role: roles map to code owners and teams (`approvers.<name>.forge: { users: [...], teams: [...] }`, or `codeowners: true` to use CODEOWNERS for the touched paths).
4. **Stale means stale.** A new push, a changed plan or policy, expiry, or the reviewer losing the role makes the approval stale, with the same reasons listed as today. Unknot never dismisses or edits reviews; it only reads them.
5. **CI evidence is attested.** Proof obligations can run as GitHub Actions jobs on the pull request head. The job uploads the evidence bundle and attests it (`actions/attest-build-provenance`). Unknot downloads the bundle, verifies the attestation (`gh attestation verify --repo <owner>/<repo> --signer-workflow <path>`), checks the subject digest and that the attested commit is the bound head, then records the evidence with actor `ci:<workflow>`. An unattested or mismatched bundle is reported and not counted.
6. **Prerequisites are checked, not assumed.** `unknot doctor` reports whether the base branch requires reviews and code-owner review, whether the agent account can push to it directly, and whether the evidence workflow is pinned by SHA. Missing protections are warnings with the setting to change.

## Flows

- **Plan approval:** `unknot apply` (or a lane) opens the draft pull request with the binding comment for stage `plan`. An approving review from the right roles satisfies the plan stage.
- **Change approval:** after patching, the pull request head is the patch. Unknot refreshes the binding comment for stage `change`. Approving reviews on that head satisfy the change stage; Unknot moves the slice to `ACCEPTED` and records an `approval.recorded` event with `via: forge`, the reviewer, the review id and the binding.
- **Lanes:** one approving review on a lane pull request that lists the covered slices and their plan digests stands in for the signed lane; change approvals stay per slice.
- **Merge:** Unknot does not merge. The person merges, as they would any reviewed pull request.

## Shared campaign state (later phase)

Campaign state and the ledger move to a git ref in the repository (`refs/unknot/ledger`): an append-only log of signed events, one file per event named by its hash. Each actor signs with their own key (person, CI identity, or a session key bound to a forge identity). Concurrent appends merge without conflicts because events never change; the projection is rebuilt from the log in a deterministic order, and two events that change the same slice state from the same predecessor are reported as a conflict for a person to resolve. This needs its own design review before it is built.

## Phases

1. Human-only rule extended to forge reviews (control 1). Small; ships first on its own.
2. Draft pull request per slice, binding comment, reading and checking reviews (controls 2 to 4), `approvals.via`, role mapping, doctor checks (control 6). GitHub only.
3. Attested CI evidence (control 5).
4. Shared state in the repository.
5. A second forge behind the same interface, passing the same tests.

Each phase gets an adversarial review before release.

## Decisions

Answered by the maintainer on 2026-10-12:

1. A review from the account the agent acts as counts only together with a local signature from that person; a review from a different reviewer with the role counts alone.
2. `approvals.via` defaults to `local`; forge approval is opt-in per repository.
3. A separate bot account for agents is documented as an option, not required.
