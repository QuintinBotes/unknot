# Forge approvals and CI verification (design)

Status: design for roadmap item 4 ([roadmap.md](roadmap.md#4-fit-with-the-governance-teams-already-use)); phases 1 to 3 (controls 1 to 6) are implemented: `unknot pr <slice>` opens a draft pull request per slice with the review summary from the proof bundle and posts the binding comment, `unknot approvals <slice>` checks the reviews ([commands.md](commands.md#unknot-pr-slice-human)), and `unknot verify --from-ci <pr>` records attested CI evidence. GitHub and GitHub Actions come first; the design keeps a forge interface so GitLab, Bitbucket and Azure DevOps can follow.

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
2. Draft pull request per slice, binding comment, reading and checking reviews (controls 2 to 4), `approvals.via`, role mapping, doctor checks (control 6). GitHub only. Done; see "As built" below.
3. Attested CI evidence (control 5). Done; see "As built (phase 3)" below.
4. Shared state in the repository.
5. A second forge behind the same interface, passing the same tests.

Each phase gets an adversarial review before release.

## As built (phase 2)

- **Scope.** Forge reviews count toward the `change` stage only. Plan and rollback approvals stay local signatures in every mode; a lane still stands in for plan approvals.
- **Config.** `approvals.via: local | forge | both` (default `local`; with `local` nothing reaches GitHub). Roles map under `approvals.forge.roles.<role>: { users: [<numeric user id>...], teams: [org/team], codeowners: true }`, role-centred rather than under each approver, because a code-owner role is held by whoever CODEOWNERS names. `approvals.forge.repository` pins the `owner/repo` whose reviews count, and `approvals.forge.base` the base branch (default: that repository's default branch); while the repository is unset no review counts. `approvals.forge.agent_accounts` lists the numeric GitHub user ids agents act as (`[]` for none); while it is unset no review counts. Who the agent is comes from this list, never from the account `gh` holds when the check runs, which a token switch would change. `approvers.<name>.github_id` links a local approver to their account for control 2. `approvals.forge.gh` is the absolute path of the `gh` binary; unset, the first of the usual install locations; `PATH` is never searched. Changing any of these is a config change: it needs acceptance and changes the policy digest, which makes posted bindings stale.
- **Binding.** `unknot pr` posts the change binding, together with the exact head commit it pushed, and their audit-key signature as a comment and records `forge.binding_posted` in the ledger. Unknot checks reviews against its own signed ledger copy, verified against the audit key, and never reads the comment back, so no pull request text is ever input.
- **Pinned repository and base.** `unknot pr` pushes only when the remote is the pinned repository, runs the configured `gh` with `--repo <pinned>`, and refuses a pull request URL outside it, so neither a `gh` shim nor `git remote set-url` can choose where reviews are read. A recorded pull request outside the pinned repository counts nothing, and so does one whose base is not the pinned repository's base branch: the base decides whose CODEOWNERS apply, so retargeting it to another branch is refused.
- **What counts.** For each reviewer only the latest `APPROVED`, `CHANGES_REQUESTED` or `DISMISSED` review stands (by review id). It counts when it is `APPROVED`, its `commit_id` is the pull request head, that head is the commit `unknot pr` pushed and signed (any other push, a force-push included, needs `unknot pr` again to bind it), the head is re-read after the reviews and has not moved, the pull request is open with head `<repo>:unknot/<slice>`, the head commit's diff against the baseline hashes to the bound `diff_hash`, the binding matches the current one field by field and has not expired, the reviewer is not the author, holds a mapped role, has write access to the repository (`collaborators/{login}/permission` is `write` or `admin`, GitHub's own rule for an owner), and, if they are a listed agent account, the approver linked to that id has a valid local signature on the same binding, and then the review counts only for the roles that signature holds. Reviewers are matched by numeric user id, so a renamed account's freed login cannot be reused. Code owners come from CODEOWNERS on GitHub at the pull request's base commit (`.github/`, root, `docs/`, last match wins), the copy GitHub itself enforces, so neither the pull request nor a local commit to the baseline can make someone an owner; with none readable, nobody is a code owner. Unknot's git ignores replace refs (`GIT_NO_REPLACE_OBJECTS`), so a local `refs/replace/*` cannot make a decoy commit read as the bound one. The head's diff is hashed with submodule changes always shown (`--ignore-submodules=none`), whatever the repository's config says. A review that fails any type check is reported as malformed and ignored; any API error counts nothing.
- **People.** With `via: forge` only reviews count. With `both`, roles may be covered by either, and `critical_min_approvers` counts people within one channel (local approvers, or reviewers), never adding the two, since a local approver and a reviewer may be the same person.
- **Transport.** Every call runs the configured `gh` (never one found on `PATH`, where an agent could plant a shim) as `gh api --hostname github.com`, without `GH_HOST`, `GH_CONFIG_DIR`, `GH_REPO`, `XDG_CONFIG_HOME`, proxy settings or extra CA settings (defence in depth, not a boundary), so gh's credentials go to api.github.com whatever `GH_HOST` or the remote say; a remote or pull request URL that is not `github.com` is refused. The head must be in the local repository (`unknot pr` keeps it under `refs/unknot/pr/<slice>`); a head pushed by someone else is checked after a `git fetch`.
- **Acceptance.** `unknot approvals <slice>` is human only, like `approve` (a terminal, no agent session, and the shell rule refuses it from an agent). When the reviews complete the change stage of a `REVIEW_READY` slice it asks the person to confirm by typing the slice id (a bare `y` from a pty an agent drives does nothing), naming the pull request, its base and head and each counted reviewer with their roles, then moves it to `ACCEPTED` and only then records each counted review as `approval.recorded` with `via: forge`, the review id, reviewer and reviewer id, head and binding. Reading the status records nothing. This keeps the same-user limit stated in SECURITY.md: an agent running as the same OS user could still replace the `gh` binary or the person's gh configuration itself.
- **`unknot approve`.** A change approval that would complete acceptance on forge reviews (`approve <slice>` or `approve --lane`) shows the same pull request, base, head and counted reviewers before asking for the passphrase.
- **Doctor.** Missing review or code-owner protection on the default branch is a failure, not a warning (the issue asks to fail); an agent account (each of `agent_accounts`) that can push without review is a failure too, and so is an unset `agent_accounts` or `repository`, or a remote that is not the pinned repository. A `gh` binary in a directory the current user can write (Homebrew's `/opt/homebrew/bin` is one) is a warning: an agent running as that user could replace it.

## As built (phase 3)

- **Setup.** Pin the evidence workflow in the accepted config, by commit: `approvals.forge.ci_workflow: QuintinBotes/unknot/.github/workflows/unknot-verify.yml@<sha>`. On the pinned repository's base branch, add a caller workflow that runs on a push to the slice branches, in a job named `unknot`, calling the same file at the same commit:

  ```yaml
  name: unknot
  on:
    push:
      branches: ['unknot/**']
  permissions: {}
  jobs:
    unknot:
      uses: QuintinBotes/unknot/.github/workflows/unknot-verify.yml@<sha>
      permissions:
        contents: read
        id-token: write
        attestations: write
        checks: write
  ```

  Then require the status check `unknot / verify` on the base branch (Settings > Branches). `unknot doctor` fails while it is not required, or while `ci_workflow` is not pinned by SHA. Artifact attestations need a public repository, or GitHub Enterprise Cloud for a private one.
- **What CI runs.** `unknot pr` ends the pushed commit's message with an `Unknot-CI:` line: for each obligation, the command `unknot verify` would run (hook checks scoped to the changed files), or why CI does not run it (a person must, or it is a built-in check that needs Unknot's graph and runs locally). The reusable workflow's `run` job checks out that commit and Unknot at the workflow's own commit (`job.workflow_sha`), runs `unknot verify --in-ci`, and uploads `unknot-evidence.json` (head, slice, diff hash, run id and attempt, and per obligation its command, exit code, timing and output digests). That job holds only `contents: read`: no OIDC token, no key, no Unknot state. The `verify` job runs no repository code: it downloads the file, attests it with `actions/attest-build-provenance`, fails if any command failed, and posts a neutral check `unknot / not run in CI` listing the obligations CI did not run, so they are never shown green.
- **What counts.** `unknot verify --from-ci <pr>` on a `REVIEW_READY` slice counts the evidence only when all of these hold, and records nothing otherwise:
  - the binding `unknot pr` posted verifies against the audit key and is current, and the pull request is open in the pinned repository at exactly the bound head, whose diff hashes to the bound diff (the #152 repository and head pins);
  - the head's `.github/workflows` tree is the one on the base branch on GitHub (a workflow changed in the pull request, or committed to the local baseline, ran instead of the base's);
  - the evidence comes from the newest push run on the head (in the pinned repository, not a fork) that uploaded it, no newer run of the same caller workflow exists, the attempt is the run's latest, and the run completed (an older run's or attempt's attestation is a replay);
  - `gh attestation verify` verifies the file against Sigstore and GitHub's OIDC identity with `--repo <pinned>`, `--signer-workflow` and `--signer-digest` (the pinned workflow at its pinned commit), `--source-digest <head>`, `--source-ref refs/heads/<slice branch>` and `--deny-self-hosted-runners`;
  - Unknot then checks the certificate itself: issuer GitHub Actions, source repository the pinned one, signer identity and signer digest the pinned workflow, source and build-config digest the head, ref the slice branch, trigger `push` (never `pull_request_target`, a fork's `pull_request` or a dispatch), a GitHub-hosted runner, the run URI the latest run's, and a subject whose digest is the downloaded file's;
  - the file names that head, the slice, the bound diff, the pinned repository and that run and attempt.

  Then each command obligation whose CI command is exactly the one this clone would run and exited 0 is recorded as passed (`evidence.recorded` with actor `ci:<workflow>`, an evidence record of kind `ci` naming the pull request, head, run, workflow and file digest, and the file in the content store), and the proof bundle is written again. Human obligations and built-in checks are never recorded from CI, whatever the file says. A failed command is reported (exit 1) and records nothing.
- **Transport.** Unknot runs the configured `gh` as `gh api --hostname github.com`, `gh run download --repo github.com/<owner>/<repo>` and `gh attestation verify --hostname github.com`, with the same environment cleaning as phase 2. gh's credentials go only to GitHub; `gh attestation verify` fetches Sigstore's trust root from Sigstore and GitHub's TUF repositories.
- **Limits.** CI evidence is as strong as the job it ran in: the slice head's own commands run in the `run` job and could change what that job reports for the obligations after them. That code is the bound change a reviewer reads; a test that games CI is in the reviewed diff. The `run` job is not OS-sandboxed like the local broker. A base branch whose workflows change after `unknot pr` makes the evidence refuse until the slice is planned again on the new base.

## Decisions

Answered by the maintainer on 2026-10-12:

1. A review from the account the agent acts as counts only together with a local signature from that person; a review from a different reviewer with the role counts alone.
2. `approvals.via` defaults to `local`; forge approval is opt-in per repository.
3. A separate bot account for agents is documented as an option, not required.
