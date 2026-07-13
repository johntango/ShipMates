# Codex worker reporting

ShipMates now has a bounded read-only Codex scout runtime. Firstmate owns the
task, lease, prompt, report validation, independent Git inspection, and ledger
events. Codex supplies a specialist report and never becomes the human-facing
agent.

## Verified CLI contract

The implementation was exercised with `codex-cli 0.144.1`. Its local help and a
live probe confirmed these interfaces:

- `codex exec --sandbox read-only` confines model-generated commands;
- `--output-schema FILE` constrains the final response;
- `--json` emits JSONL events including `thread.started` and `turn.completed`;
- `--output-last-message FILE` writes the structured final report;
- `codex exec resume SESSION_ID` exists, but ShipMates does not invoke it yet.

The earlier mutating exercise did not receive its configured last-message file.
The repaired runtime creates the artifact directory before launching Codex and
writes the CLI event stream directly to an open file descriptor. The report is
accepted only if all of the following exist and agree:

1. exactly one non-empty `thread.started` identity;
2. a `turn.completed` event;
3. a parseable last-message JSON file;
4. exactly the fields required by the tracked report schema;
5. the exact ledger task ID;
6. an independent post-run Git inspection proving the lease is still clean at
   its recorded head.

Terminal output is not evidence.

## Authority boundary

The child process receives:

- the leased worktree as its working directory;
- `read-only` Codex sandboxing;
- a bounded scout brief;
- the tracked JSON report schema;
- an empty worker-specific `GH_CONFIG_DIR`;
- no inherited `GH_TOKEN`, `GITHUB_TOKEN`, or `OPENAI_API_KEY`;
- disabled interactive Git credential prompts.

The runtime retains the existing Codex ChatGPT login. The worker is instructed
not to modify files, create commits, use GitHub, or address the human. Firstmate
still verifies the repository rather than trusting those instructions.

## Durable artifacts and events

Worker artifacts are operational state under:

```text
.shipmates/tasks/TASK_ID/workers/WORKER_ID/
  codex-events.jsonl
  codex-stderr.log
  report.json
  gh-config/
```

The task ledger records:

```text
worker.dispatch.requested
  -> task: running -> awaiting_worker
  -> worker.started (Codex thread ID)
  -> worker.report.recorded (report plus Firstmate verification)
  -> task: awaiting_worker -> running
```

The dispatch event includes the full brief, its SHA-256 digest, backend, mode,
sandbox, worker ID, and exact worktree path. Event IDs are deterministic, so
replaying the same completed operation is idempotent.

## Running a scout

The task must already be `running` with an active, clean Treehouse lease. From
the ShipMates repository root run:

```sh
node scripts/codex-scout.js run \
  TASK_ID \
  scout-001 \
  "Inspect the bounded question and return a structured report."
```

The CLI takes the brief as one quoted argument. It does not acquire or return a
lease; those remain separate Firstmate-controlled transitions.

After accepting the report, finish a read-only task with the ledger-backed
Treehouse command documented in the
[Treehouse guide](treehouse-integration.md).

## Restart recovery

ShipMates records dispatch intent before starting Codex. It will not dispatch
the same worker again if that intent already exists.

If Firstmate stops while Codex is running, the child writes JSONL directly to
the durable event file. After proving that the original worker has stopped or
completed, run:

```sh
node scripts/codex-scout.js reconcile TASK_ID WORKER_ID
```

Reconciliation requires a completed turn and valid report, restores the exact
thread ID, repeats independent Git inspection, and records the result. Missing,
partial, mismatched, or mutation-tainted artifacts fail closed.

The legacy direct-process workflow still stops after one turn. The newer Codex
MCP workflow exposes `codex-reply` only through its separate crash-safe reply
events, atomic reply artifact, exact thread/lease binding, and repeated sandbox
revalidation. See [the Codex MCP specialist guide](codex-mcp-specialist.md).

## Live learning exercise

Task `codex-scout-20260713` ran worker `scout-001` against the clean practice
commit `4894811cf35e6e7b6559d4d75f2da78d24791c92`.

Codex recorded thread `019f5cc0-e139-7220-9bc5-4909d84396a3`, inspected
`src/message.js` and `test/message.test.js`, and reported five passing tests.
Firstmate independently confirmed that the detached worktree remained clean at
the exact leased SHA. The final task contains 18 replayable events, reached
`complete`, and returned the Treehouse lease to `available`.
