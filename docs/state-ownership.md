# State ownership and invariant contract

The machine-readable contract is `src/state/state-contract.js`. Its schema
version is 1. `shipmates invariants [--json]` checks the contract read-only; it
does not rebuild snapshots, clear pointers, reconcile attempts, or mutate an
external system.

## Authority

| Owner | Authoritative facts |
| --- | --- |
| Task event ledger (`tasks/TASK/events.jsonl`) | Execution history, lifecycle transitions, durable operation intent, approvals, receipts, observations, validation and delivery evidence |
| Project registry (`projects.json`) | Project/repository identity, plan/dependency structure, Project status, task-attempt relationships, launch identity, archive/deletion metadata |
| External systems | Process existence, Git HEAD/status, Treehouse lease ownership, no-mistakes run state, GitHub PR/check/merge state |
| Derived projections | `snapshot.json`, `active-project.json`, dashboard output, and Herdr metadata; none can override an owner above |

An observation becomes durable history only through a valid task event. A
process exit, pane status, dashboard badge, snapshot field, or active pointer is
never sufficient authority for a lifecycle transition.

## Project registry fields (schema 1)

The document fields are `schemaVersion`, `activeProjectId`, `projects`, and
`repositoryDeletionReceipts`. Each Project persists `id`, `name`, `repo`,
`repoPath`, `baseSha`, `objective`, `status`, `tasks`, `executionPolicy`,
`demoMode`, `protected`, `archiveReceipt`, `createdAt`, and `updatedAt`.

Each plan task persists `id`, `title`, `description`, `status`, `dependsOn`,
`taskId`, `previousTaskIds`, `attempts`, and `blockingReason`. `taskId` and
`previousTaskIds` are compatibility projections of `attempts`; relationships
are owned by the attempt history. Each attempt persists `taskId`, `status`,
`startedAt`, `completedAt`, `blockingReason`, and optional `launchReceipt`.
A launch receipt persists `kind`, exactly one of `pid` or `paneId`, and
`launchedAt`. Persistent execution policy persists `mode`, `scouts`,
`validation`, `autoAdvance`, `branch`, and `worktreePath`.

Repository deletion receipts and archive receipts are typed workflow receipts;
their schema versions and exact target/evidence fields are defined and verified
by their owning workflows before registry persistence.

## Task event ledger fields (event schema 1)

Every JSONL record has exactly the envelope fields `id`, `taskId`, `type`, `at`,
`actor`, and `data`. Event IDs are idempotency keys. Timestamps never move
backward, task IDs never change, and the first event is exactly `task.created`.
The `data` payload fields by family are:

| Event family | Persisted data fields |
| --- | --- |
| `task.created` | `kind`, `repo`, `baseSha` |
| `task.transitioned` | `from`, `to`, optional `reason` |
| `task.evidence.recorded` | `kind`, `value` |
| `task.approval.recorded` | `repo`, `prNumber`, `headSha`, `mergeMethod`, `decision` |
| `github.status.recorded` | `report` (repository, PR identity/head/state, required checks, actor, observed time) |
| `github.merge.*` | approval/request identity, repository, PR, exact head, method, operation/request IDs, result or failure code |
| `github.draft_pr.*` | approval/request identity, repository, exact head/base/title/body digests, operation/request IDs, created PR or failure |
| `github.post_merge.verified` | `report` (approved head, merge/base commits, repository/PR, required checks and landed-tree proof facts) |
| `git.push.*` | approval/request IDs, repository, branch, exact head, operation/request IDs, result or absence failure |
| `git.branch_cleanup.*` | approval/request IDs, repository/path, branch/head/base, merge proof, operation/request IDs, result or failure |
| `git.commit.*` | operation/attempt/worker/report IDs, base head, branch, changed paths, message/digest, request ID and exact result |
| `validation.local.*` | operation/attempt IDs, exact head/branch/intent/tool binding, request ID, normalized run report or reconciled run ID |
| `recovery.audit.recorded` | `report` with ledger watermark, observations, decisions, recommended actions and safe-to-resume result |
| `firstmate.run.*` | request/attempt/digest/model bounds, request ID, classification/usage or sanitized failure |
| `worktree.lease.*` | repository/path/base, attempt/request IDs, leased path/head/branch |
| `worktree.branch.*` | attempt/branch/expected head/changed paths, request ID and verified result |
| `worktree.proof.recorded` | proof kind, verification, path/head and kind-specific no-mutation or exact-tree facts |
| `worktree.return.*` | path, proof/request IDs |
| `worker.dispatch.requested` | worker/backend/mode/path/sandbox/brief digest and bounded brief |
| `worker.started` | worker and dispatch IDs, thread ID |
| `worker.report.recorded` | worker/start IDs, structured report and independent verification |
| `worker.failed` | worker/start IDs and sanitized failure |
| `worker.reply.*` | worker/reply IDs, prompt digest, request ID, thread/report/verification or sanitized failure |
| `scout.synthesis.recorded` | synthesis ID, worker/report bindings, checks and conclusion |
| `scout.follow_up.*` | follow-up/synthesis/check/worker/reply bindings, selected or resolved report digest and comparison |

The derived task snapshot schema is 1 and persists `schemaVersion`, `id`,
`kind`, `state`, `repo`, `baseSha`, `worktree`, `workers`, `eventsCount`,
`lastEventId`, `lastEventAt`, `evidence`, `approvals`, `githubObservations`,
`githubDraftPrApprovals`, `githubDraftPullRequests`, `githubMergeApprovals`,
`githubMerges`, `postMergeAssurances`, `gitCommits`, `gitPushApprovals`,
`gitPushes`, `branchCleanupApprovals`, `branchCleanups`, `validationRequests`,
`validationRuns`, `recoveryAudits`, `firstmateRuns`, `scoutSyntheses`, and
`scoutFollowUps`. Nested fields are deterministic normalized copies of the
validated event payloads above; replay, not the snapshot file, owns them.

The active pointer schema is 1 with `schemaVersion`, `taskId`, and `updatedAt`.
Herdr projection schema 1 includes its source ledger watermark. Dashboard files
are rendered artifacts and persist no lifecycle authority.

## Migrations

- A legacy Project task without `attempts` migrates `previousTaskIds` and
  `taskId` into attempt records during registry read. The compatibility fields
  remain derived from that history.
- Missing `repositoryDeletionReceipts` migrates to an empty array.
- A missing or corrupt task snapshot is rebuilt only from the complete event
  ledger; no reverse migration from snapshot to events exists.
- Missing, malformed, stale, unreadable, or completed-task active pointers
  derive to no active task.
- There is no implicit migration for an unknown schema version or event type;
  invariant checking fails closed and requires an explicit migration.

## Invariants

Registry invariants require unique plan IDs, valid dependencies, one active
attempt per plan task, unique task-attempt ownership (including across
Projects), a current-attempt record for `taskId`, and a reason for blocked work.
A completed Project contains only completed plan work. Executed plan history
cannot disappear during revision.

Ledger invariants require a unique event ID and task identity, ordered valid
timestamps, valid state transitions, exact operation/request/approval bindings,
one-time approval consumption, exact repository and Git-head binding, and
proof-before-return/delivery/merge cleanup. Repeating an identical event is
idempotent; reusing its ID with different content fails.

Projection invariants require persisted snapshots to equal event replay, Herdr
to cite the current ledger watermark, and active pointers never to restore a
completed or unreadable task. Unknown persisted fields are contract violations,
because every persisted field must have an owner and migration policy.
