# Durable mutating Codex worker

`CodexShipWorkflow` is the single-worker workspace-write supervisor for an
already active Treehouse lease. It records durable dispatch intent before
starting Codex, preserves the JSONL and structured report artifacts, and
accepts the result only after an independent Git inspection.

## Authority boundary

The worker receives:

- the exact task-bound Treehouse worktree;
- Codex `workspace-write` sandboxing;
- no GitHub or OpenAI API token inherited from Firstmate;
- an empty GitHub CLI profile;
- a brief that prohibits commits, pushes, GitHub access, `.git` changes,
  `.shipmates` changes, or lease cleanup.

Only one `ship` worker is dispatched by the current Firstmate path. Read-only
scouts may still run concurrently, but mutating-worker concurrency remains
disabled.

## Independent mutation verification

Before dispatch, Firstmate requires the lease to be clean at its recorded SHA
and branch. After the worker exits, it independently obtains:

- current `HEAD` and branch;
- staged paths;
- unstaged paths;
- untracked, non-ignored paths.
- ignored paths, which must remain empty.

The worker must not create a commit, stage files, change branches, or create
ignored files. Its `report.files` must
exactly equal the sorted Git path set. Absolute paths, parent traversal,
`.git`, and `.shipmates` are rejected. A completed implementation must change
at least one path; a blocked worker may truthfully finish with no mutation.

The ledger records a `workspace-write` verification with the base and final
SHA, before/after branch, exact changed paths, dirty state, and explicit
`commitCreated: false`. The work remains uncommitted and leased for the next
Firstmate-controlled commit and validation stage.

## Crash safety

The durable sequence is:

```text
worker.dispatch.requested
  -> task: running -> awaiting_worker
  -> codex JSONL/report artifacts
  -> worker.started
  -> independent Git mutation verification
  -> worker.report.recorded
  -> task: awaiting_worker -> running
```

A repeated completed worker ID and identical brief reuses the ledger result. An
existing requested or started worker is never dispatched again. After proving
the original process stopped, reconcile its completed artifacts with:

```sh
npm run codex:ship -- reconcile TASK_ID IMPLEMENTER_ID
```

If the runtime returns an ordinary failure, ShipMates records the sanitized
failure, moves the task to `recovery_required`, and preserves the leased
workspace for inspection. A report/path mismatch remains `awaiting_worker` so
the inconsistent artifacts and worktree cannot be mistaken for accepted work.

## Firstmate integration

For `local_write`, `npm run firstmate` now advances the clarified task to
`approved_for_dispatch`, obtains a durable Treehouse lease, runs both scouts in
that isolated workspace, and delegates implementation to this supervisor. The
result prints the leased `workspacePath`; it does not copy uncommitted changes
back into the primary checkout.
