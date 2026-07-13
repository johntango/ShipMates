# Two-scout evidence synthesis

`ScoutSynthesisWorkflow` compares exactly two terminal, independently verified
read-only scout reports. It is a deterministic Firstmate-owned evidence gate,
not another model call and not a worker authority grant.

## Authority checks

The workflow fails closed unless both named workers:

- exist and have durable `reported` status;
- ran in `scout` mode with `sandbox=read-only`;
- have a thread and report event bound to the current task;
- have independent `noMutation: true`, `dirty: false` verification;
- were verified at the same durable worktree head and path.

The task may already be complete and its lease returned. Synthesis never changes
task state, advances validation, reacquires Treehouse authority, launches a
worker, operates a pane, or calls GitHub.

## Conservative comparison

The artifact preserves the two source reports separately with worker, thread,
report-event, report-digest, pane, and exact-head identity. It then records:

- `agreements`: exact matches for status, branch, commit, files, test
  command/results, summaries, and risks;
- `disagreements`: differing scalar authority claims or different results for
  the same test command;
- `unsupportedClaims`: report content not exactly corroborated by the peer;
- `followUpChecks`: deterministic checks proposed for every disagreement or
  peer-uncorroborated claim.

Here, unsupported means only "not corroborated by the peer report." It does not
mean false. Similar prose is deliberately not merged semantically, because that
would require an additional inference authority.

An artifact is `aligned` only when it has no disagreement and no unsupported
claim. Otherwise it is `review_required`. Neither outcome advances the task.

## Crash safety and monitoring

The canonical JSON artifact is written atomically under:

```text
.shipmates/tasks/TASK_ID/syntheses/SYNTHESIS_ID.json
```

The ledger records its SHA-256 digest, exact source report event IDs, worker
IDs, lease head, outcome, and counts. Repeating the same synthesis ID reads and
verifies the bound artifact without appending another event. A missing, changed,
or differently bound artifact is rejected rather than regenerated.

Herdr projects only synthesis identity, authority digest, outcome, and counts.
It does not display source report prose. A `review_required` synthesis becomes
an attention item. Any evidence appended after a restart audit also makes that
audit visibly stale until a fresh read-only audit is recorded.

## Command

```sh
npm run scout:synthesize -- run \
  TASK_ID SYNTHESIS_ID WORKER_A WORKER_B
```

The CLI prints only the durable binding and counts, not the embedded reports.

## Verified live exercise

`pair-evidence-review-v1` synthesized `scout-pane-left-v2` and
`scout-pane-right-v2` for task `parallel-mcp-scout-20260713` at practice SHA
`4894811cf35e6e7b6559d4d75f2da78d24791c92`. It recorded seven exact
agreements, one differing `npm test` result description, thirteen
peer-uncorroborated claims, and fourteen proposed checks. The outcome was
`review_required`; task state remained `complete`, the lease remained returned,
and restart audit `restart-live-synthesis-001` recorded `safeToResume: true`.
