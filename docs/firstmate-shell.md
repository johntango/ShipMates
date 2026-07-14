# One-agent Firstmate shell

ShipMates now has an OpenAI Agents SDK intake shell backed by a bounded local
executor. It owns the first conversation boundary, classifies the requested
work, records durable intent and result events, and can dispatch local Codex
workers. It never writes to GitHub.

## Runtime boundary

The shell uses `gpt-5.6-luna` by default with:

- one maximum agent turn;
- strict Zod structured output;
- no tools or handoffs;
- reasoning effort `none`;
- a 512-token output cap;
- response storage disabled;
- tracing disabled by default;
- sensitive trace payloads disabled even when tracing is enabled.

Set `SHIPMATES_FIRSTMATE_MODEL` to choose an explicitly approved model. Set
`SHIPMATES_FIRSTMATE_TRACING=true` to enable SDK tracing for a run. The API key
is loaded by Node from the ignored `.env` file and is never written to the task
ledger.

## Durable call protocol

For each request, Firstmate records this sequence:

```text
task.created
  -> firstmate.run.requested
  -> one Agents SDK call
  -> firstmate.run.classified
  -> task.transitioned (proposed -> clarified)
```

The request event contains the model configuration, a SHA-256 digest of the
user message, and a unique attempt claim. It does not contain the API key or raw
message. The result event contains the validated classification and aggregate
token usage.

The attempt claim closes a concurrent-writer race: if two processes try the
same request ID, only the event carrying the winning claim can be appended. The
other process fails before reaching the API. A later retry returns an existing
classification without another model call. If intent exists with no terminal
result, ShipMates reports an uncertain run and will not retry automatically.

SDK or schema failures produce a sanitized `firstmate.run.failed` event. The raw
model output, stack, request headers, and credential are not persisted.

## Classification contract

The model returns:

- a concise summary;
- task type;
- minimum required authority;
- approval boundary;
- recommended next step;
- whether human approval is required.

The Zod schema and the independent ledger reducer both enforce the contract.
Read-only and local-write classifications have no approval boundary.
External-write and destructive classifications must use their corresponding
human-approval boundary.

## Interactive CLI

From the ShipMates repository root:

```sh
npm run firstmate
```

Firstmate discovers `owner/repo` from the Git `origin`, captures `HEAD`, creates
UUID-derived task and request IDs, displays `You:`, and waits for the prompt.
The generated identifiers use 80 random bits and satisfy the ledger's readable
identifier format; users do not need to invent or increment IDs.

The classified authority controls execution:

- read-only requests run two independent read-only Codex scouts;
- local-write requests run both scouts, then one workspace-write implementation
  worker with the scout reports as advisory context. The local-write path first
  acquires a task-bound Treehouse lease and records durable worker intent,
  artifacts, and independently verified changed paths;
- external-write and destructive requests stop at their human-approval boundary
  before any local worker starts.

Workers receive no `OPENAI_API_KEY`, `GH_TOKEN`, or `GITHUB_TOKEN`. The local
implementation worker is told not to commit or publish and runs in Codex's
`workspace-write` sandbox. Its exact Git changes must match its report before
acceptance. Execution evidence is recorded under the task ledger and detailed
worker artifacts remain under ignored `.shipmates/tasks/` state. Verified
changes remain uncommitted in the leased `workspacePath`; they are not copied
into the primary checkout.

When invoked from a Herdr pane, Firstmate also creates live worker-pane
visibility for both scouts and the implementer. Sanitized status updates show
tool type and lifecycle but never raw commands, arguments, prompt text, or tool
output. See the [Herdr status guide](herdr-status.md#live-firstmate-execution).

For classification without worker execution:

```sh
npm run firstmate -- --classify-only
```

## Explicit automation protocol

Scripts may still supply stable identifiers and repository identity explicitly:

```sh
npm run firstmate -- \
  intake-001 request-001 \
  johntango/Shipmates-Practice BASE_SHA \
  "Inspect the current implementation and report risks"
```

Worker execution requires those explicit repository values to match the current
checkout's `origin` and `HEAD`. This prevents an automation typo from running a
worker in the wrong repository. Detached intake for another repository must use
`--classify-only`.

For scripts, the prompt can also be piped over standard input:

```sh
printf '%s\n' 'Inspect the current implementation and report risks' | \
  npm run firstmate -- \
  intake-001 request-001 \
  johntango/Shipmates-Practice BASE_SHA
```

Operational events are written under the ignored `.shipmates/tasks/` directory.
The CLI prints the typed classification, aggregate usage, ledger watermark, and
verified worker reports.

## Verification

Tests inject a fake runner and never contact the OpenAI API. They cover typed
output, tool absence, trace settings, replay, same-ID idempotency, concurrent
claims, uncertain intent, sanitized failure evidence, and changed-input
rejection.

```sh
node --test test/firstmate-context.test.js test/firstmate-message.test.js \
  test/firstmate-local-executor.test.js test/firstmate.test.js \
  test/task-state.test.js test/task-store.test.js
node --test
git diff --check
```
