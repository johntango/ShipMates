# Controlled commit and exact-head validation

Firstmate converts an independently verified workspace mutation into one task
commit and validates that exact commit before any publication authority can be
requested. The implementation worker never receives Git commit or GitHub
authority.

## Commit authority

`FirstmateCommitWorkflow` accepts only a terminal `ship` worker whose verified
changed-path set is non-empty and still matches the active Treehouse lease. It
records `git.commit.requested` before invoking Git. The request binds:

- the worker and its report event;
- one collision-resistant execution attempt, preventing concurrent claim reuse;
- the lease branch and base `HEAD`;
- the sorted exact changed-path set;
- the fixed message `ShipMates task TASK_ID` and its digest.

`ControlledGitCommitAdapter` starts with no staged or ignored paths. It stages
only the bound paths, re-inspects the index, disables signing and hooks, and
creates one commit with the fixed author and committer:

```text
ShipMates Firstmate <firstmate@shipmates.local>
```

Acceptance requires a clean worktree, unchanged branch, exactly one parent
equal to the requested base, the fixed message and identity, and a base-to-head
path set equal to the durable request. Only then does
`git.commit.completed` advance the lease's authoritative `headSha` and move the
task from `running` to `validating`.

## Pinned local validation

Before leasing a workspace, the executable verifies the configured
no-mistakes binary against all three pins:

- version `v1.37.0`;
- source commit `78e4dcb234274199717acafa90abca5cf7013993`;
- Darwin ARM64 binary SHA-256
  `d4558d241100cb48196a00864157fb70bb5aa241ac376bcbf48dda88fb033e34`.

Validation records `validation.local.requested` before execution. The request
binds the exact committed lease head, branch, user-intent digest, and binary
pin. The existing local-only no-mistakes adapter then disables `rebase`,
`push`, `pr`, and `ci`, strips remote credentials, and independently verifies
that the branch and full SHA remain unchanged. The result is accepted only
when it matches the durable request and the active lease.

The full interactive path is:

```text
npm run firstmate
  -> two read-only scouts
  -> verified workspace-write worker
  -> durable controlled commit
  -> durable pinned local-only validation
  -> stop in validating state before publication
```

Set `NO_MISTAKES_BIN` to the pinned executable when it is not at the development
default `/private/tmp/shipmates-no-mistakes-v1.37.0/no-mistakes`.

## Crash recovery

An incomplete commit request is never executed again automatically. After
proving the original process has stopped, inspect the existing candidate
commit without mutation:

```sh
npm run firstmate:commit -- reconcile TASK_ID
```

Reconciliation records the result only if the current commit exactly matches
the original base, branch, message, identity, and path authority. A partial
stage, dirty tree, extra commit, changed branch, or mismatched commit remains a
manual recovery condition.

An incomplete validation request is also never rerun automatically. The
restart auditor reports `reconcile_local_validation_manually`; raw validator
state must be inspected before deciding whether to record evidence or start a
new task attempt.
