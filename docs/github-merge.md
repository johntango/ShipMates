# Human-approved exact-head squash merge

ShipMates exposes one merge capability through Firstmate delivery mode. It is
separate from worker, branch-push, draft-PR, and CI authority and accepts only a
squash merge of the exact approved pull-request head.

This milestone adds the capability and tests it with injected GitHub clients. It
does not merge a live pull request during routine validation or publication.

## Preconditions

Before recording human approval, and again immediately before mutation,
Firstmate independently reads and requires:

- the task's completed draft-PR operation identifies the same repository, PR,
  branch, and full head SHA;
- the PR is open, no longer a draft, not merged, and GitHub reports it mergeable;
- its base is the active repository's current default branch;
- squash merging is enabled;
- every required default-branch check passes at the approved head;
- the configured number of current-head reviews is approved;
- conversation resolution is enforced by branch policy;
- every paginated GraphQL review thread is resolved;
- review policies requiring code-owner or last-pusher identity are absent until
  ShipMates can independently prove those identities.

Unknown, unsupported, moved, or conflicting evidence is refusal. GitHub branch
protection remains the final concurrent-change backstop, while the merge request
also supplies the expected full head SHA atomically.

The draft-PR gateway cannot mark a PR ready. A human must make that separate
GitHub change before requesting merge approval, then refresh CI evidence:

```sh
npm run firstmate:delivery -- ci TASK_ID PR_OPERATION_ID
```

## Approval and compare-and-act merge

Record the exact human decision:

```sh
SHIPMATES_HUMAN_ACTOR=YOUR_NAME npm run firstmate:delivery -- \
  approve-merge TASK_ID MERGE_APPROVAL_ID
```

The approval binds the repository, PR number, full head SHA, default branch,
merge method `squash`, and the exact status-evidence event reviewed at approval.
It also records the normalized review-thread count, SHA-256 digest, and zero
unresolved result. One approval can be consumed by one operation.

Perform the separately confirmed mutation:

```sh
npm run firstmate:delivery -- \
  merge TASK_ID MERGE_OPERATION_ID MERGE_APPROVAL_ID
```

Immediately before writing, Firstmate records a collision-resistant merge
intent, a fresh review-thread digest/count, and re-runs all read-only
preconditions. The only write is equivalent to
GitHub's pull-request merge endpoint with:

```json
{"sha":"FULL_APPROVED_HEAD","merge_method":"squash"}
```

Completion requires a confirming PR read with the same head and merge commit,
plus a default-branch read proving it points to that merge commit. The ledger
then advances from `ready_to_merge` through `merging` to `landed`.

## Recovery

Any error after the merge request begins is uncertain. Never issue a second
merge automatically:

```sh
npm run firstmate:delivery -- \
  reconcile-merge TASK_ID MERGE_OPERATION_ID
```

Reconciliation is read-only. An exact merged PR and matching default-branch
head records recovered completion. A proven open and unmerged PR records failure
and requires a new human approval. Changed heads, closed-unmerged PRs, or an
advanced default branch require manual recovery.

`landed` does not release the Treehouse lease. Post-merge CI, exact-tree landing
proof, lease return, and branch cleanup remain later, separately bounded stages.
