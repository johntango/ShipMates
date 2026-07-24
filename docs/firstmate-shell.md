# One-agent Firstmate shell

ShipMates now has an OpenAI Agents SDK intake shell backed by a bounded local
executor. It owns the first conversation boundary, classifies the requested
work, records durable intent and result events, and can dispatch local Codex
workers. Intake mode never writes to GitHub. Explicit delivery mode can invoke
the separately approved exact-head push and draft-PR gateways for an existing
validated task.

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

Interactive Firstmate also starts the ShipMates operator dashboard at
`http://127.0.0.1:4390`. The Express server uses locally installed Bootstrap
assets and offers System, Light, and Dark display modes; the selected mode is
remembered by the browser. Live task state is streamed from the durable ledger.
The command form is explicitly labeled “Send to Firstmate” and uses the same
dispatcher as terminal input, so it can coordinate Scouts and the Implementer
without a separate Lavish poller. The server binds only to localhost and stops
when Firstmate exits.

For a read-only view when Firstmate is not running, use:

```sh
npm run dashboard
```

The standalone view can display ledger state but cannot accept instructions;
start `npm run firstmate` to enable the command form.

Ask Firstmate to “open the dashboard in Lavish” to create a standalone visual
review fixture from the same Bootstrap markup, CSS, JavaScript renderer, and
locally installed Bootstrap bundle as the live dashboard. Representative
active, completed, failed-validation, and stale-worker states replace the live
ledger, and command submission is disabled. This makes visual comments safe
and repeatable without launching workers or changing operational state.

The web command box accepts multiline instructions directly. In the terminal,
enter `/paste`, paste any number of lines, then enter `/send` so Firstmate
dispatches the entire text as one request. Enter `/cancel` to discard the
buffer. A single `.` remains accepted for compatibility.

Firstmate discovers `owner/repo` from the Git `origin`, captures `HEAD`, creates
UUID-derived task and request IDs, displays `You:`, and waits for the prompt.
After dispatching a request, interactive mode immediately displays `You:` again
while that task continues in its worker panes. Task completion or failure is
reported asynchronously, and each new prompt receives a fresh durable task
identity and re-reads the repository context. Enter `/exit`, `exit`, or `quit`
to stop accepting instructions; already dispatched tasks are allowed to finish.
Explicit task arguments, piped input, `--classify-only`, and delivery commands
remain one-shot automation interfaces.

Interactive requests now pass first through one durable, read-only Codex
conversation owned by Firstmate. This is distinct from the bounded Scouts and
Implementer: it retains conversational context, may inspect the selected
repository, explains decisions in ordinary language, and chooses whether to
answer, apply a control operation to an exact existing task, dispatch one
governed task, or save a multi-task project plan. Approvals, recovery,
reconciliation, accepted demo warnings, and status requests are control-plane
operations and cannot create a worker or a new plan row. Explicit planned-task
attachment is atomic and refuses completed or already-dispatched work. It cannot
write the repository or bypass Treehouse, controlled commits, no-mistakes, or
the separately approved GitHub gateways. If the conversational runtime is
unavailable, Firstmate reports the fallback and preserves the existing governed
dispatcher.

Projects are stored in `.shipmates/projects.json` with an exact local checkout,
GitHub `owner/repo`, base commit, objective, and dependency-aware task plan.
Each stable plan task owns an `attempts` history. Retries remain nested beneath
that task with their task ID, status, timestamps, and blocking reason; they never
become additional plan rows. The legacy `taskId` and `previousTaskIds` fields are
maintained as compatibility projections while existing registries migrate on
read. Plan revisions preserve every executed task and refuse to remove a plan
item that already has attempts.

On startup, the project orchestrator deterministically inspects non-persistent
active and blocked attempts. It can reconcile an already-complete ledger,
complete verified no-change demo work, preserve a capability warning for human
acceptance, identify validation repair, or require worker/artifact
reconciliation. It records the precise blocking reason and never launches a
retry during recovery inspection. Registry writes enforce unique plan IDs, one
active attempt per plan task, unique attempt ownership, valid dependencies, a
current-attempt record, and a reason for every blocked task.

While Firstmate is running, the same safe reconciliation executes every 15
seconds by default (`SHIPMATES_MONITOR_SECONDS` may adjust it, with a five-second
minimum). A successful child exit immediately advances the next dependency-ready
task. The periodic monitor also reconciles durable completion evidence and
advances ready local-only demo work without waiting for a restart. It does not
waive failed tests, grant permissions, repeat uncertain external operations, or
dispatch around a recorded blocker.
Useful conversational commands are:

```text
add project /absolute/path/to/another/repository
create project AnotherProjectInTheSelectedRepository
list projects
switch project ProjectName
enable demo mode for ProjectName
archive project ProjectName
preview purge project repository ProjectName
confirm purge project repository /absolute/path/to/repository CONFIRMATION_ID
```

`enable demo mode for ProjectName` is an explicit project-scoped, local-only
capability-demo policy. Demo tasks still use the controlled local commit and
the Implementer's focused checks, but skip no-mistakes and every remote
delivery operation. The task ledger records `demo-validation-skipped`, and the
project registry retains `demoMode: true`; normal projects are unaffected.

`archive project ProjectName` performs verified bulk cleanup only after every
planned task is complete, post-merge checks and exact-tree assurance passed,
the Treehouse worktree was returned, and the separately approved remote task
branch cleanup completed. It replaces the project with a compact registry
receipt containing the PR and exact merge identity, then removes project-owned
task ledgers, dashboards, worker artifacts, persistent-run records, and Project
Agent job records. Archived projects are hidden from normal project listings.
The same archival step runs automatically after successful branch cleanup or
its reconciliation; PR creation alone never archives data.

`preview purge project repository ProjectName` is the irreversible alternative
for an abandoned project repository. It enumerates every linked Project, task,
and managed worktree, refuses protected repositories and recorded live
processes, and returns a state-bound confirmation ID. Enter the exact displayed
`confirm purge project repository ...` command to remove ShipMates records,
ledgers, generated artifacts, conversation references, managed worktrees, and
Herdr visibility. Purge keeps no receipt and leaves both GitHub and the main
local checkout unchanged, so delete those separately only after purge succeeds.

Repository selection is convenient conversational state only; every dispatched
task still records its exact repository and base SHA. Broad objectives are saved
as plans for review rather than launched all at once. Subsequent concrete
instructions can bind execution to a planned task while independent repository
projects remain isolated.

The dashboard provides bounded project controls. **Approve plan** moves a saved
plan into dispatchable state; **Pause project** prevents new planned work from
being selected without stopping an already running task; **Resume project**
restores dispatch; arrow controls reorder still-planned tasks; and **Dispatch
next ready task** selects the first task whose declared dependencies are
complete. The dashboard action returns immediately while Firstmate continues
the governed dispatch asynchronously. These controls do not commit, push,
merge, or grant external authority.

Conversational artifact follow-ups such as “show me the files,” “where are
they?”, and “open the pages” do not require a task ID. Firstmate keeps a running
build as the immediate conversational target; otherwise it searches durable
history for the newest task that actually produced implementation artifacts.
A newer answer-only or ambiguous request with no files therefore cannot hide
the most recent useful result. Responses use human-facing descriptions while
retaining exact internal task identity in the ledger and artifact paths.

Revision language such as “modify the existing implementation,” “change the
page,” or “make it blue” continues the active project. Firstmate discovers the
active project's exact worktree HEAD and starts a new task from that commit,
with the shared authoritative state directory retained. The earlier task is
never reopened or mutated: Scouts and the Implementer receive a fresh isolated
Treehouse revision containing the project's existing files. A clearly new
build request starts a new project and becomes the conversational target after
it produces artifacts.

When an interactively dispatched task exits, Firstmate writes an HTML dashboard
to `.shipmates/tasks/TASK_ID/lavish/dashboard.html` and opens it through the
locally pinned Lavish Editor. It summarizes the durable task state, workers,
validation result, and exact implementation file locations. Three read-only
controls can ask Firstmate to show files, task status, or validation. Each sends
an allowlisted, versioned action bound to the exact task ID; unknown actions and
task mismatches are rejected. Push, approval, mutation, and arbitrary prompt
actions are not exposed in this stage. A separate “What next?” panel uses native
radio controls so tentative changes remain in the browser until the human
presses “Submit choice.” Review files, review validation, and no action remain
non-mutating. After the exact task commit passes no-mistakes, the panel also
offers “Deliver changes to this checkout.” That task-bound decision invokes a
local fast-forward workflow; it never pushes or opens a pull request.

Local delivery rechecks that the task lease is active, its worktree is clean,
the controlled commit and no-mistakes result name the same exact SHA, the main
checkout is clean, and its HEAD still equals the task base. It then runs an
exact `git merge --ff-only SHA`, verifies the resulting clean HEAD, records
delivery evidence, and completes the task ledger. A dirty or diverged checkout
is rejected without attempting the merge. Repeating an already completed
delivery is idempotent.

Verified `.html` and `.htm` implementation artifacts also receive a “Review
page” control. Firstmate resolves the selected file index against the exact
implementer report and Treehouse worktree, rejects non-HTML and escaping paths,
then opens that page in a separate Lavish visual-review session. The review can
collect annotations, but this stage deliberately does not apply them to code or
resume the implementation worker; feedback application is the next durable
workflow boundary.
The generated identifiers use 80 random bits and satisfy the ledger's readable
identifier format; users do not need to invent or increment IDs.

The classified authority controls execution:

- requests are decomposed into one or two distinct work items, with exactly one
  read-only Codex scout assigned to each item. Indivisible requests use one
  scout; separable outputs may use two, and an assignment is never duplicated;
- local-write requests run the assigned scouts, then one workspace-write implementation
  worker with the scout reports as advisory context. The local-write path first
  acquires a task-bound Treehouse lease and records durable worker intent,
  artifacts, and independently verified changed paths. Firstmate then creates
  one exact task commit and runs the pinned local-only no-mistakes gate against
  that commit. A passing run reports the repository, branch, and SHA awaiting a
  separate human push approval;
- external-write and destructive requests stop at their human-approval boundary
  before any local worker starts.

Workers receive no `OPENAI_API_KEY`, `GH_TOKEN`, or `GITHUB_TOKEN`. The local
implementation worker is told not to commit or publish and runs in Codex's
`workspace-write` sandbox. Its exact Git changes must match its report before
acceptance. Firstmate alone stages the verified paths with a fixed identity,
records the resulting single-parent commit, and validates its exact SHA with a
digest-verified no-mistakes binary. Execution evidence is recorded under the
task ledger and detailed worker artifacts remain under ignored
`.shipmates/tasks/` state. The committed lease is not copied into the primary
checkout automatically and is not pushed by the intake run. The dashboard's
explicit local-delivery choice can fast-forward a clean primary checkout after
validation. The separate
[`firstmate:push` workflow](exact-head-push.md) owns that exact external write.

When invoked from a Herdr pane, Firstmate launches each scout as a real Codex
process in its assigned worker pane. The pane shows a sanitized lifecycle and
tool-type stream while the complete Codex JSONL and structured report remain in
the task artifact directory. The implementer uses the same pane-local runtime
after its isolated Treehouse worktree is prepared. If pane allocation or Herdr
reporting is unavailable, execution falls back to the local Codex runtime and
the authoritative artifacts remain unchanged. Raw commands, arguments, prompt
text, and tool output are never copied into Herdr status messages. See the
[Herdr status guide](herdr-status.md#live-firstmate-execution).

For classification without worker execution:

```sh
npm run firstmate -- --classify-only
```

## Continuing a validated task

Delivery mode resumes an existing task without asking for a new prompt or
dispatching workers:

```sh
npm run firstmate -- --delivery status TASK_ID
```

It coordinates ledger-derived exact-head push, separately approved draft-PR
creation, read-only CI observation, a third separately approved exact-head
squash merge, post-merge CI/tree assurance, crash-safe lease return, and a
fourth separately approved exact remote branch cleanup. See the
[Firstmate delivery guide](firstmate-delivery.md) for the approval and recovery
commands.

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
npm test
git diff --check
```
## Response and validation speed

Firstmate answers common project-status, selected-project, repository, and planned-task
questions directly from the durable project registry. These queries do not start a
conversational Codex turn. Planned tasks that feed another task use the fast local
validation profile: tests and lint still run, while repeated review and documentation
passes are deferred. Terminal project milestones, unplanned work, and delivery continue
to use the full pinned no-mistakes local gate.

## Persistent project execution

Simple approved projects may opt into `persistent_project` execution. Each project owns
one long-lived `shipmates/<project>` Git branch and worktree. Planned tasks run one Codex
Implementer directly in that worktree with no Scouts by default. The Implementer runs
focused checks, Firstmate commits the exact reported paths, and the next planned task
continues from that commit. The full pinned no-mistakes gate runs only for a terminal
project milestone. Unplanned, risky, and delivery work continues to use the governed
per-task Treehouse workflow.

Firstmate reconciles completed persistent-run records at startup. Its 15-minute watchdog
reports live or unreconciled execution separately from ledger records older than 24 hours;
historical records appear only in the dashboard cleanup section and are never presented
as live processes.

### Project Agent ownership

Every persistent project has one Agents SDK Project Agent registered in Herdr as
`ShipMates Project: <name>`. The registration remains visible while the project is
paused or idle, so temporary Implementer and validator processes always have a named
owner. The Project Agent has no unrestricted shell and no handoffs. Its fixed tools can
only inspect its project, dispatch or reconcile one Implementer, run terminal-milestone
validation, or refer an approval/recovery condition to Firstmate and the human.

Herdr projects the owner through `coordinating`, `implementing`, `reconciling`,
`validating`, `awaiting-human`, `paused`, and `completed` states. The dashboard shows
the same owner, persistent branch, and worktree. The 15-minute watchdog reads both the
legacy task ledger and persistent Project Agent run records; a completed artifact is
reconciled rather than dispatched again.
