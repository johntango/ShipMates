# Two parallel read-only scouts in Herdr

ShipMates can dispatch exactly two Codex MCP scouts concurrently on one active,
clean Treehouse lease. Each scout has a distinct worker ID, Herdr pane, Codex
thread, brief, artifact directory, and durable ledger history.

## Pane pool

The Firstmate pane is never a worker slot. `HerdrPanePool` prefers panes in the
same tab, then other panes, and creates a right-hand split only when fewer than
two verified slots exist.

A reusable pane must satisfy all of these checks:

- it is not the current Firstmate pane;
- Herdr has no agent attached to it;
- no nonterminal worker in any readable task snapshot reserves its pane ID;
- `pane process-info` reports exactly one foreground process;
- that process is the pane's own idle `sh`, `bash`, `zsh`, or `fish` shell.

`agent_status: unknown` alone never proves vacancy. A pane running an
interactive command such as `gh auth login` is rejected. New panes are verified
with the same process check before use.

## Durable dispatch and authority

Firstmate records both `worker.dispatch.requested` events, including pane IDs,
while the task is `running`. It then moves the task once to `awaiting_worker`
and launches both pane commands with `Promise.allSettled`.

The pane command receives only the state directory, task ID, and worker ID. The
artifact-only worker reloads its durable dispatch and refuses to run unless:

- the task is `awaiting_worker` on an active lease;
- its backend is `codex-mcp` and sandbox is `read-only`;
- its pane environment matches the durable pane ID;
- its worktree matches the durable lease.

The Codex MCP adapter continues to strip OpenAI API and GitHub credentials,
enforce `approval-policy=never`, and write only its validated result artifact.
The pane worker never writes the task ledger.

`herdr pane run` acknowledges scheduling rather than process completion. The
pane worker therefore atomically writes `pane-terminal.json` after success or a
sanitized failure. The launcher waits for that exact task/worker/pane marker
before evaluating the Codex artifact; scheduling acknowledgement alone can
never mark a worker complete or failed.

## Completion and restart

The Firstmate coordinator loads each artifact, records its thread, independently
re-inspects the exact worktree for each report, and accepts `noMutation: true`
only at the leased SHA. A pane is released only after its worker has a durable
terminal report or failure.

If Firstmate stops, `reconcile` loads existing artifacts and never relaunches a
worker. One worker may become durably reported while the other remains
`dispatch_requested` or `started`; the task stays `awaiting_worker`, the uncertain
pane remains reserved, restart monitoring names its pane, and Herdr shows both
states. The task returns to `running` only when both workers are terminal. It
does not advance to validation unless both reports were independently verified.

## Commands

Store each bounded brief in a UTF-8 file:

```sh
npm run codex:mcp-pair -- run \
  TASK_ID WORKER_A BRIEF_FILE_A WORKER_B BRIEF_FILE_B
```

After interruption:

```sh
npm run codex:mcp-pair -- reconcile TASK_ID WORKER_A WORKER_B
```

Monitor the pair without mutation:

```sh
npm run herdr:status -- view TASK_ID
```

## Verified live exercise

Task `parallel-mcp-scout-20260713` used practice SHA
`4894811cf35e6e7b6559d4d75f2da78d24791c92`. The successful pair ran
concurrently as `scout-pane-left-v2` in `w1:p2` and `scout-pane-right-v2` in
`w1:p3`, with distinct Codex threads. Both reported five passing tests and each
received its own clean exact-SHA verification. The lease was returned, both pane
agents were released, and restart audit `restart-live-parallel-panes-001`
recorded `safeToResume: true`.

The ledger intentionally retains an earlier failed pair. That attempt exposed
that Herdr's pane-run response confirms scheduling, not command completion. The
pane commands later refused stale task authority and made no Codex call. The
atomic terminal-marker protocol above was added before the successful retry;
historical failures were not rewritten.

This stage permits two parallel read-only scouts only. It does not permit two
mutating workers, shared worker panes, duplicate worker IDs, automatic relaunch,
or parallel GitHub writes.
