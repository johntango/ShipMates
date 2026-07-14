# Restart reconciliation

`RestartReconciler` converts a replayed task snapshot and fresh read-only
observations into one durable restart decision. It never leases or returns a
worktree, dispatches or resumes a worker, responds to a validation gate, or
changes GitHub.

Each invocation requires an explicit `auditId`. Retrying the same ID returns the
already-recorded report without repeating observations. A new audit ID requests
a fresh read.

## Checks

The reconciler:

- proves the authoritative JSONL event history replayed;
- compares Treehouse state and holder with the durable worktree lifecycle;
- independently checks the active worktree SHA and cleanliness;
- identifies worker starts whose durable artifacts need reconciliation;
- accepts a dirty active lease only when its exact Git path set matches a
  terminal independently verified workspace-write worker;
- distinguishes selected scout follow-ups that need safe dispatch, reply-artifact
  reconciliation, or resolution from an already verified reply;
- identifies controlled commit intent without a result and directs the operator
  to read-only commit reconciliation;
- identifies exact-head push intent without a result and directs the operator
  to read-only remote reconciliation; a proven absent branch requires a new
  human approval rather than a retry;
- identifies merge intent without a result and directs the operator to read-only
  GitHub reconciliation rather than a second merge request;
- requires a completed merge to have passing exact-commit CI evidence, a
  matching exact-tree proof, and a returned lease before cleanup is complete;
- identifies uncertain remote branch deletion and directs the operator to
  read-only ref reconciliation rather than a second delete;
- identifies pinned local validation intent without a result and refuses an
  automatic rerun;
- checks whether validation evidence matches the active lease;
- re-reads every recorded PR's immutable head, state, and required checks.

Every check is `pass`, `not_applicable`, or `recovery_required`. A report is
`safeToResume` only when no check requires recovery. Recommendations name an
existing bounded recovery operation; the auditor does not invoke it.

Run an audit with the pinned Treehouse environment and authenticated GET-only
GitHub gateway:

```sh
PATH=/opt/homebrew/bin:$PATH \
HOME=/private/tmp/shipmates-treehouse-home \
TREEHOUSE_BIN=/private/tmp/treehouse-v2.0.0/treehouse \
TREEHOUSE_NO_UPDATE_CHECK=1 \
node scripts/restart-reconcile.js TASK_ID AUDIT_ID
```

## Verified restart exercise

Three complementary histories were audited after constructing new reconciler
instances:

- `codex-scout-20260713`: ledger replay, returned Treehouse slot, and terminal
  worker report all matched;
- `github-read-20260713`: PRs #1 and #2 retained their exact recorded heads,
  closed state, and successful required `test` checks;
- `local-validation-20260713`: the pinned local validation report remained a
  passing result at the recorded SHA.

All three reports recorded `safeToResume: true` with no recommended action. A
same-ID retry of `restart-live-github-001` succeeded with an invalid Treehouse
binary and no network permission, proving it returned durable evidence without
repeating observations.
