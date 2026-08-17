# Independent architecture review request: hardening ShipMates

## Purpose

Please provide a critical second opinion on how to make the ShipMates code
development pipeline substantially less brittle while retaining its strong
evidence, security, and human-approval controls.

Do not assume that the remedies proposed below are correct. Challenge the
architecture, identify unnecessary complexity, and recommend the smallest
coherent changes that address the underlying failure modes. This is an
architecture and workflow review, not a request to write code.

The detailed historical handoff is preserved after this review packet as
supporting context. Give greater weight to this section when history conflicts
with it.

## What ShipMates is trying to guarantee

ShipMates coordinates a gated software-development lifecycle with these role
and authority boundaries:

- A human gives requirements and approvals to Firstmate.
- Firstmate plans, delegates, reconciles evidence, and controls integration.
- Scouts may inspect and report but may not modify code.
- One Implementer may modify only its leased, task-bound Git worktree.
- Implementers may not commit, push, open pull requests, merge, or change
  GitHub settings.
- A controlled executor owns Git commits and GitHub mutations.
- Validation runs against an exact candidate commit with remote mutation
  disabled unless separately authorized.
- Process disappearance is not proof of completion and is never, by itself,
  permission to retry.
- Every handoff requires durable, identity-bound evidence: task identity,
  repository, base and candidate commits, commands, results, artifacts,
  limitations, and a next-gate recommendation.
- After interruption, the system must reconcile durable evidence before
  retrying an operation.
- Existing unrelated changes and operational evidence must not be cleaned,
  reset, overwritten, or accidentally included.

These constraints are deliberate. A recommendation that merely weakens
fail-closed controls, silently retries uncertain mutations, or trusts worker
prose is not acceptable.

## Current architecture

The system presently has several durable and external state holders:

- The task event ledger records execution history, transitions, operations,
  and receipts.
- The Project registry records plan structure, repository identity, Project
  status, and task-attempt relationships.
- Git repositories and refs record worktree and commit facts.
- Treehouse manages leased task worktrees.
- The no-mistakes pipeline performs review, repair, validation, and custody
  transfer using its own managed repository and refs.
- Processes and terminal panes provide transient observations only.
- Snapshots, active-task pointers, the dashboard, and Herdr views are intended
  to be projections, though they have sometimes behaved like independent
  state.
- A durable-operation protocol and reconciliation engine exist, but not every
  lifecycle action has been migrated to one uniform protocol.

Relevant implementation areas include:

- `src/operations/durable-operation.js`
- `src/reconciliation/reconciliation-engine.js`
- `src/core/task-state.js`
- `src/storage/task-store.js`
- `src/projects/project-store.js`
- `src/workflows/local-validation.js`
- `src/workflows/local-delivery.js`
- `src/workflows/restart-reconciliation.js`
- `src/workflows/codex-ship.js`
- `src/adapters/no-mistakes.js`
- `src/cli/firstmate-control-intent.js`

## Recent evidence from the DeepO project

DeepO Release 1 was ultimately completed locally at commit
`a79a35c336f6bc63418e3c21365a5422e570087c`; it was not pushed remotely. The
software work succeeded, but coordination repeatedly stopped on handoff and
recovery boundaries rather than on code defects.

Observed incidents included:

1. A valid Implementer report was rejected because ignored Python
   `__pycache__` files existed. The mutation verifier treated every ignored
   path as disallowed evidence, without distinguishing disposable runtime
   artifacts from suspicious ignored source or binary content.
2. A controlled commit request was durably recorded, then sandbox permissions
   denied creation of Git's worktree `index.lock`. Reconciliation correctly
   proved that no commit had occurred, but the workflow lacked a first-class,
   safe way to replay the operation after proving the prior mutation absent.
   Manual adapter replay was required.
3. no-mistakes legitimately created review-fix commits. The ShipMates task
   ledger remained bound to the original submitted commit, so the exact commit
   under review evolved without a corresponding candidate-lineage model.
4. no-mistakes custody recovery repeatedly failed because the receiving local
   tracking ref was stale even though the final commit existed in the managed
   bare repository. Manual fetch, strict fast-forward verification, and custody
   retry were needed.
5. The Project registry and task ledger temporarily disagreed. A task could be
   `awaiting_human` while the Project projection still appeared dispatched or
   completed.
6. Natural-language commands containing exact task IDs were sometimes routed
   as Project queries instead of deterministic task-control operations.
7. Quiet or exited processes created operational pressure to relaunch even
   though durable results later existed. The policy prevented duplicates, but
   recovery was slow and manual.
8. Treehouse capacity and completed or stale worktrees caused repeated
   dispatch friction and manual lease cleanup.

The working diagnosis is that timing exposes the failures but is not their
root cause. More fundamental causes appear to be:

- transient observations being treated as authority;
- multiple stores owning overlapping lifecycle facts;
- external mutation and durable recording not being atomic;
- operations that are not uniformly idempotent or replay-safe;
- exact-commit validation interacting poorly with validators that can repair
  code and therefore create a new commit;
- semantic checks being enforced at the wrong boundary; and
- recovery logic being spread across startup, watchdogs, adapters, command
  handlers, and one-off manual procedures.

## Candidate direction under consideration

We are considering the following direction, but want it independently
critiqued:

1. Make the task event ledger the sole authority for execution and operation
   history. Derive Project status from plan structure plus task attempts rather
   than persisting overlapping status where possible.
2. Represent candidate evolution explicitly as an immutable lineage, for
   example `submitted -> review_fix -> test_fix -> final_validated`, with each
   edge carrying producer identity, parent commit, reason, evidence, and
   validation state.
3. Treat validation that can modify code as a candidate-producing operation,
   not as validation of the original candidate. Require a final mutation-free
   validation pass against the resulting exact commit before approval.
4. Give every external operation a stable idempotency key and a durable state
   such as `prepared`, `claimed`, `effect_observed`, `verified`, `failed`, or
   `uncertain`. Recovery should inspect postconditions before deciding whether
   to record completion, resume observation, or authorize a new attempt.
5. Centralize recovery decisions in one deterministic reconciliation planner
   used by startup, watchdogs, dashboards, and explicit commands.
6. Make process state advisory. Durable receipts plus independently verified
   external postconditions determine completion.
7. Classify ignored paths through a narrow policy: known disposable artifacts
   may be documented and removed or ignored safely, while unknown ignored
   content remains fail-closed and visible.
8. Make custody transfer explicitly fetch/observe the source commit, verify
   ancestry and destination expectations, perform a strict fast-forward, and
   record both source and destination object identities.
9. Add an end-to-end fault-injection harness that interrupts execution before
   and after every intent, mutation, receipt, verification, and projection
   update.

## Questions for the reviewer

Please address these directly:

1. Is the diagnosis correct? What deeper causes or misleading assumptions are
   we missing?
2. What should be the single source of truth for task, Project, candidate,
   operation, and approval state? Which facts should be derived rather than
   persisted?
3. What state machines and invariants would you use? Please distinguish task
   lifecycle, attempt lifecycle, candidate lineage, and external-operation
   lifecycle.
4. Should a validation pipeline be allowed to modify code? If so, how should
   repair commits, convergence limits, evidence, and exact-HEAD revalidation be
   modeled? If not, what practical workflow should replace it?
5. How should crash-window recovery decide among `not_started`, `completed`,
   `unreconciled`, `retryable_failure`, and `manual_repair_required` without
   duplicating an external mutation?
6. How can task and Project status be kept consistent without fragile
   cross-file transactions?
7. What is a safe policy for disposable ignored artifacts that does not create
   a hiding place for unreviewed code, secrets, or large binaries?
8. How should ref refresh and custody transfer work across a managed validation
   repository, a task worktree, and the registered destination checkout?
9. Which deterministic commands should replace natural-language control at
   lifecycle gates while still allowing a conversational Firstmate interface?
10. Which failure-injection and concurrency tests are essential before calling
    the pipeline reliable?
11. What is the smallest migration path that preserves existing event ledgers
    and active projects?
12. Which proposed controls add more complexity than reliability, and what
    would you simplify or remove?

## Requested form of the response

Please return:

1. A concise root-cause assessment.
2. A target architecture and authoritative-state model.
3. Proposed state machines and explicit invariants.
4. Recovery algorithms or pseudocode for the important crash windows.
5. A prioritized roadmap divided into P0, P1, and P2, with dependencies and
   measurable acceptance criteria.
6. A test and fault-injection matrix.
7. A backward-compatible migration strategy.
8. Security and authority implications.
9. Tradeoffs, rejected alternatives, and a simpler option if the proposed
   architecture is over-engineered.

Please separate facts from inferences and identify any repository evidence you
would need before making a firm recommendation. Optimize for reliable progress
and understandable recovery, not merely maximal formalism.

---

# ShipMates Codex handoff

## Current handoff — 2026-07-25

This section supersedes every older "Current handoff" and resume instruction
below. ShipMates has recently completed a real TestA project, but that exercise
exposed systemic reliability weaknesses. The next milestone is **ShipMates
reliability**. Do not add orchestration features until this milestone is
complete.

### Immediate resume instruction

Start in `/Users/johnwilliams/MIT/Courses/ShipMates`, then:

1. Read this entire 2026-07-25 section.
2. Run `git status --short --branch` and inspect local/remote branch state.
3. Preserve `.shipmates/` operational evidence and unrelated user changes.
4. Confirm the current test baseline with `npm test` before editing.
5. Begin the first reliability tranche described below.

Do not blindly retry, redispatch, reset, clean, purge, or delete operational
state. Inspect and reconcile existing evidence first.

### Current verified outcome

- TestA in the registered DemoTest0 Project Repository is complete. All three
  planned tasks are recorded completed.
- The final TestA task was delivered locally at exact validated commit
  `a912c8dc77ea5874e97ecc410f652adb42aa505b`.
- Validation approval and delivery recovery, harmless `.DS_Store` handling,
  interactive request error containment, and completed-task active-context
  cleanup were merged through ShipMates PRs #13, #14, and #15.
- Permanent repository purge was merged through PR #11. Superseded PR #12 was
  closed.
- Old merged GitHub feature branches were deleted; `main` is the only intended
  long-lived remote branch.
- Firstmate is running in Herdr, but its current architecture remains too
  brittle to treat successful TestA completion as proof of general reliability.

### Reliability diagnosis

The recurring failures share several causes:

- Project state is split across the Project registry, task event ledgers,
  snapshots, active-task pointers, Git repositories, Treehouse worktrees,
  no-mistakes runs, Herdr panes, and live processes.
- External actions and ledger transitions are not atomic. A process exit between
  mutation and durable recording creates uncertain state.
- Recovery behavior is distributed across startup, watchdog, command handlers,
  adapters, and one-off fixes rather than owned by one reconciliation engine.
- Natural-language classification still controls lifecycle behavior that should
  be deterministic.
- The Firstmate terminal process is coupled to project supervision.
- Dashboard and Herdr projections have sometimes reflected stale process or UI
  state instead of authoritative task state.
- Unit coverage is broad, but lifecycle interruption, shutdown, timer,
  concurrency, and cross-system tests remain insufficient.

Three concrete watchdog defects are still expected at the start of this
milestone unless a newer commit has already fixed them:

1. `watchdog.inspect()` can reject outside the guarded blocks and terminate
   Firstmate through an unhandled interval promise.
2. The watchdog interval is cleared only after normal loop completion and can
   leak after abnormal terminal or request-loop failure.
3. Invalid `SHIPMATES_MONITOR_SECONDS` input can become `NaN` and create an
   effectively hot timer.

The adjacent concurrency defect must be fixed at the same time: `setInterval`
can begin another reconciliation audit while the previous audit is still
running.

### Reliability contract

ShipMates must guarantee all of the following:

- A task is dispatched at most once unless an explicit retry creates a new
  attempt.
- Killing or restarting Firstmate never loses proven completed work.
- Repeating a control or recovery command is safe and idempotent.
- Every blocked state gives the exact reason and a concrete recovery action.
- Every `awaiting human` state emits an explicit question or exact approval
  command.
- Completed tasks never reappear as active.
- Delivery always targets the registered Project Repository and lands the exact
  validated commit.
- Herdr and dashboard state are derived from authoritative durable state.
- Closing the Firstmate terminal does not destroy durable supervision.
- Uncertain external actions are observed and reconciled before repetition.

### First implementation tranche

Implement these as small, separately reviewable vertical changes:

1. **Watchdog and shutdown hardening**
   - Replace overlapping `setInterval` execution with a serialized scheduler
     that schedules the next audit only after the current audit finishes.
   - Catch reconciliation, stale terminalization, and inspection failures
     independently, plus attach a final scheduled-task rejection handler.
   - Keep scheduler ownership outside the interactive-loop success path and
     cancel it from `finally`.
   - Parse the monitor setting as a finite positive number and otherwise use the
     documented 15-second default, retaining the five-second minimum.
   - Test startup inspection failure, periodic inspection failure, abnormal
     loop exit, invalid configuration, shutdown, and slow non-overlapping
     audits.

2. **Read-only system doctor**
   - Add `shipmates doctor` with project/task filters and structured output.
   - Observe Project registry, task ledger, processes, worktrees, Git heads,
     validation runs, and registered destination repositories without mutation.
   - Report invariant violations, uncertainty, stale projections, and the exact
     recommended recovery operation.
   - Keep `doctor` read-only. A later explicit `reconcile` command may perform
     only independently proven safe, idempotent repairs.

3. **State-ownership specification and invariant checker**
   - Task event ledger owns task execution history and operation evidence.
   - Project registry owns plan structure, repository identity, task-attempt
     relationships, and Project status.
   - External systems own only facts such as process existence, Git HEAD,
     worktree leases, no-mistakes status, and GitHub state.
   - Snapshots, active pointers, dashboard data, and Herdr metadata are derived
     projections, not independent authority.
   - Document every persisted field, schema version, migration, and invariant.

4. **Lifecycle failure-harness skeleton**
   - Exercise register → plan → approve → dispatch → report → commit → validate
     → approve → deliver → complete in a disposable repository.
   - Add injectable termination points before and after each durable intent and
     external action.
   - Prove restart completion without duplicate workers, commits, validation
     runs, deliveries, or task attempts.

Each tranche must include focused tests, the full supported `npm test` suite,
documentation, no-mistakes validation, and CI before merge.

### Architectural sequence after the first tranche

1. **Central reconciliation engine** — observe actual state, compare it with
   authoritative state, and produce one deterministic decision such as
   `no_action`, `record_observed_completion`, `resume_existing_validation`,
   `retry_delivery`, `mark_worker_lost`, `return_verified_lease`,
   `request_human_approval`, or `require_manual_repair`. Startup, monitoring,
   dashboard actions, and Firstmate commands must use this same engine.
2. **Uniform crash-safe operation protocol** — every external operation records
   durable intent, stable idempotency key, exact target, preconditions, claim,
   receipt/observation, verification, and terminal result. Apply it to worker
   launch, worktree lease/return, branch preparation, commit, no-mistakes,
   delivery, push, PR, merge, branch cleanup, archive, and purge.
3. **Deterministic Firstmate control plane** — natural language may select a
   typed command, but model prose must not decide lifecycle transitions.
   Commands include project create/approve/advance, task inspect/reconcile,
   validation approve, delivery retry, archive, and purge. Refusals must name
   the failed invariant and next action.
4. **Durable supervisor separation** — move reconciliation, process observation,
   advancement, scheduling, and projections into a durable supervisor. Treat
   the Firstmate pane as a reconnectable conversational client.
5. **Derived observability** — Herdr and dashboard show authoritative state,
   live observations, exact blockers, recovery actions, validation commit, and
   delivery destination. Remove persisted UI-only active state.
6. **Lifecycle simplification and migration** — separate lifecycle state from
   operation state, represent retries as attempts, define terminal states and
   owners, migrate live records, then remove obsolete compatibility fields.

### Required failure coverage

The lifecycle suite must eventually terminate and restart at every boundary,
including worker launch, commit, validation start/pass/approval, local delivery,
task completion, and Project completion. It must also cover stale PIDs, missing
panes, invalid configuration, `.DS_Store`, real dirty checkout changes, moved
Git heads, missing/corrupt snapshots, duplicate commands, slow monitors,
network failure, and terminal validation records whose original intent is no
longer present in the latest projection.

### Reliability milestone completion criteria

The milestone is complete only when:

- `shipmates doctor` reports a clean system after every normal Project.
- Termination at every tested lifecycle boundary resumes to correct completion.
- Repeated recovery commands cause no duplicate external mutation.
- No completed task is restored as active.
- No human-waiting state lacks an explicit prompt.
- No monitor overlaps or survives shutdown.
- Dashboard and Herdr converge automatically to authoritative state.
- Delivery reaches the registered checkout at the exact validated commit.
- Firstmate resolves every recoverable blocker through deterministic commands.
- Unrecoverable conditions stop safely and state the exact human action needed.

### Delivery strategy

Avoid a large rewrite. Prefer this PR sequence:

1. watchdog and shutdown hardening;
2. read-only doctor;
3. state-ownership specification and invariant checker;
4. unified reconciliation planner;
5. validation and delivery migration;
6. worker and worktree migration;
7. deterministic Firstmate command router;
8. durable supervisor separation;
9. removal of obsolete projections and compatibility fields.

Do not declare the workflow reliable merely because the unit suite passes. The
decisive evidence is repeatable end-to-end recovery under injected interruption
and uncertain external state.

## Current handoff — 2026-07-17

Firstmate orchestration hardening is implemented in the dirty worktree. Preserve
all existing changes and operational task artifacts. Exact task references and
model-selected control operations now handle approval, status, recovery, and
accepted demo warnings without dispatching workers. Explicit planned-task
attachment is atomic, refuses duplicates and unbound work, and occurs before a
child process starts. Planned tasks retain blocking reasons. Local-only demo
completion accepts independently verified no-change work without an empty
commit, and an accepted browser-only warning can advance the existing blocked
demo task without a retry. Dashboard progress counts only completed plan work
and renders blocking reasons. Terminal multiline input uses `/paste`, `/send`,
and `/cancel`. `npm test` is scoped to `test/` so ignored `.shipmates`
worktrees cannot contaminate ShipMates validation.

Focused and full product validation passed on 2026-07-17: `npm test` reported
293 passing tests and `node --check scripts/firstmate.js` passed. A raw
`node --test` is intentionally no longer the supported command because Node's
recursive discovery includes preserved historical tests beneath ignored
operational worktrees.

The next platform layer is also complete in the dirty worktree. Plan tasks now
own first-class `attempts[]` histories, with the old task ID fields retained as
compatibility projections. Registry invariants prevent duplicate plan IDs,
multiple active attempts, cross-task attempt reuse, missing dependencies,
missing current attempts, and blocked work without a reason. Plan revisions
cannot discard executed task history. `ProjectOrchestrator` owns control
routing, attempt attachment, deterministic recovery classification, and startup
reconciliation for non-persistent projects. Startup reconciliation records
exact blockers and safely completes only already-proven demo work; it never
dispatches a retry. The dashboard nests attempt history under its stable plan
task. The live registry was inspected read-only: ShipMates, DemoTest, and TestA
all satisfy the new invariants. A strict-output schema omission initially made
the TestB planning turn fall back to direct dispatch; `controlType` and `taskId`
are now included in the schema's required-key list. The unstarted fallback task
was cancelled with no worker, worktree, or file changes, its synthetic row was
detached through the new evidence-checked dismissal operation, and the intended
six-stage TestB plan was saved in `planning` state for dashboard review. Full
validation now reports 304 passing tests.

Firstmate is now proactive while it remains open: successful child exit advances
the next dependency-ready task immediately, and a deterministic monitor runs
safe reconciliation every 15 seconds by default before the watchdog audit. It
can consume durable completion evidence and advance ready demo work without a
restart. Unchanged blockers are not rewritten on every pass, and failed tests,
permissions, or uncertain external operations remain stopped.

## Current handoff — 2026-07-16

This section supersedes the older 2026-07-13 handoff below. Preserve the entire
dirty worktree. Do not reset, clean, stage, commit, or push it unless the human
explicitly requests that operation.

### Immediate resume instruction

Start in `/Users/johnwilliams/MIT/Courses/ShipMates`, read this file, run
`git status --short --branch`, and inspect current project state before editing.
The next priority is to diagnose and finish BallsA verification without
duplicating work. BallsB is complete in the project registry.

### Current product architecture

- Firstmate is a persistent conversational Codex coordinator with a Bootstrap
  dashboard and durable project registry in `.shipmates/projects.json`.
- Persistent projects use one branch/worktree, one Project Agent, one
  Implementer, no scouts by default, focused tests after edits, and full
  no-mistakes validation only at the terminal milestone.
- BallsA uses `shipmates/ballsa` at
  `.shipmates/project-worktrees/BallsA`; BallsB uses `shipmates/ballsb` at
  `.shipmates/project-worktrees/BallsB`.
- Project Agent work is launched visibly in assigned Herdr panes through
  `src/adapters/herdr-project-task.js` and
  `scripts/project-agent-pane-worker.js`. Durable job/terminal markers live in
  `.shipmates/project-agent-jobs/`.
- `src/agents/project-agent.js` does not trust model prose as completion. It
  reconciles durable evidence and deterministically launches the sole
  Implementer if the model omitted the tool call.
- Persistent projects auto-advance after approval, resume, Firstmate startup,
  and successful task completion. They stop for completion, pause, a genuine
  blocker, or a required human decision.
- Genuine human inputs/decisions print as bold red
  `HUMAN INPUT REQUIRED:` messages through `src/cli/terminal-style.js`.
- The dashboard supports selecting projects, approving, pausing/resuming,
  dispatching the next task, and task priority controls.

### Current project state

- BallsB: approved; setup, interface, physics, interaction, polish, and verify
  are all recorded completed.
- BallsA: setup, interface, physics, interaction, and polish are completed.
  Verify is currently recorded blocked under `task-31be5fd80f3d4824be5f`.
- A prior BallsA verify attempt (`task-60d2df70687b43038663`) changed
  `script.js` and `tests/verify.mjs`; syntax, focused verification, diff checks,
  and production asset checks passed. Browser visual regression was unavailable
  because Playwright had no browser binary.
- That prior attempt incorrectly reported blocked because it tried to commit
  through a sandbox whose Git worktree metadata is outside its writable area.
  The Implementer must not commit; `PersistentProjectExecutor` owns the
  controlled commit.
- `src/workflows/persistent-project-executor.js` now tells the Implementer to
  ignore conflicting commit language and includes `commitBoundaryOnly()` to
  recover a report blocked solely at the executor-owned commit boundary when
  all reported tests passed.
- Despite that change, BallsA verify is blocked again. Inspect the newest
  persistent run record, Project Agent terminal marker, no-mistakes output, and
  BallsA worktree status before deciding whether to reconcile or repair. Do not
  blindly dispatch another worker.

### Validation and safety

- The full ShipMates suite last passed with 446 tests after Project Agent pane
  execution, deterministic Implementer enforcement, continuous project
  advancement, dashboard selection, and terminal highlighting changes.
- Focused tests for the later commit-boundary recovery passed (5/5), and
  `git diff --check` passed.
- The worktree contains extensive intentional tracked and untracked changes
  accumulated during this collaboration. Preserve all of them.
- `.shipmates/` is ignored operational state but is essential for diagnosing
  the live BallsA/B projects.

### Suggested first checks

```bash
git status --short --branch
node -e 'const p=require("./.shipmates/projects.json"); console.log(JSON.stringify(p.projects.filter(x=>/^Balls[AB]$/.test(x.name)),null,2))'
find .shipmates/persistent-project-runs/project-4e4c3b19b21d4c028cf6 -maxdepth 3 -type f -print | sort
git -C .shipmates/project-worktrees/BallsA status --short --branch
node --test test/persistent-project-executor.test.js test/project-agent.test.js test/herdr-project-task.test.js
```

When reporting to the human, use project/task names rather than task IDs except
where an ID is necessary as supporting evidence.

Updated: 2026-07-13, America/New_York

## Resume instruction

Start the next Codex session in:

```text
/Users/johnwilliams/MIT/Courses/ShipMates
```

Then say:

> Read HANDOFF.md, inspect the current worktree without discarding any changes,
> and continue with the bounded synthesis follow-up stage.

Before editing, the next session must run `git status --short --branch` and
`node --test`. Existing changes are intentional and must not be reset, cleaned,
overwritten, staged, committed, or pushed without explicit human direction.

## Objective and authority model

ShipMates is a staged development orchestrator. The human communicates only
with Firstmate. Firstmate delegates bounded tasks to isolated crewmates while
retaining task state, GitHub authority, approvals, evidence validation, merge,
and cleanup decisions.

The implementation is intentionally fail-closed:

- instructions do not grant credentials or authority;
- workers cannot merge, delete branches, return leases, or administer GitHub;
- sensitive GitHub mutations require exact-target evidence and human approval;
- terminal output and worker claims are not authoritative evidence;
- uncertain external operations are reconciled rather than repeated.

## Repository locations and verified state

ShipMates development repository:

```text
/Users/johnwilliams/MIT/Courses/ShipMates
local HEAD: b329803a837cbe3fe4b9a18e5eae916b1457bc2a
branch: main tracking origin/main
tests: 92 passing with node --test
```

Disposable practice repository:

```text
/Users/johnwilliams/MIT/Courses/Shipmates-Practice
GitHub: johntango/Shipmates-Practice
branch: main tracking origin/main; local .gitignore modification present
HEAD: 4894811cf35e6e7b6559d4d75f2da78d24791c92
tests: 5 passing with node --test
```

Final verification observed one user-confirmed practice-repository change:
`.gitignore` contains an added `.shipmates` entry. The synthesis stage did not
edit it, and it was preserved exactly as-is. Inspect and account for this user
change before any future Treehouse lease or clean-base claim.

Treehouse exercise environment:

```text
binary: /private/tmp/treehouse-v2.0.0/treehouse
HOME: /private/tmp/shipmates-treehouse-home
required PATH prefix: /opt/homebrew/bin
current pool state: no retained worktrees or leases
```

Treehouse v2.0.0 Darwin ARM64 archive checksum:

```text
66022f36eb0c79d6f242025f266b782ac947b3a2817005f13425cbd18874f1f9
```

## Worktree ownership warning

The ShipMates worktree is intentionally dirty. Current tracked modifications:

```text
.gitignore
agent.js
package.json
```

`agent.js` contains the user's Herdr corrections. `package.json` contains the
user's `codex` script. Preserve both. The ShipMates work added only
`.shipmates/` to `.gitignore`; `.env` remains ignored.

Current untracked paths include:

```text
HANDOFF.md
README.md
backups/
codex-headr.sh
docs/
schemas/
scripts/
src/
test/
```

Some untracked paths predate the architecture work. Do not infer ownership from
Git status and do not commit the combined worktree without a deliberate scope
review and explicit approval.

No ShipMates architecture changes have been committed or pushed. No current
task branch or Treehouse lease is outstanding.

## Completed learning stages

### GitHub governance

- Created local and GitHub `Shipmates-Practice` repositories.
- Protected `main`: PR required, current `test` check required, administrators
  included, force pushes/default-branch deletion blocked, conversations resolved.
- Completed protected PR #1 and PR #2 with exact-head human approval.
- Used squash merge without bypass.
- Proved landed work by exact Git tree equality.
- Deleted task branches only after separate human authorization.

### Treehouse adapter and workflow

- Added `TreehouseWorktreeManager` in `src/adapters/treehouse.js`.
- Checks compatible Git behavior before lease acquisition.
- Parses exact lease paths and structured Treehouse status entries.
- Provides clean inspection, no-mutation proof, exact-tree landing proof, and
  proof revalidation immediately before return.
- Added restart-safe intent/result workflow in
  `src/workflows/treehouse-ledger.js`.
- Uncertain lease or return operations are never automatically repeated.
- Recovery verifies exact worktree path, task holder, state, SHA, and cleanliness.

### Durable task ledger

- `src/core/task-state.js`: explicit lifecycle reducer and typed domain events.
- `src/storage/task-store.js`: authoritative append-only JSONL history,
  replayable snapshots, idempotent event IDs, atomic replacement, and
  cross-process task locks.
- Operational state is ignored under `.shipmates/`.
- Snapshot damage can be rebuilt from JSONL; malformed history fails closed.
- Eight separate writer processes are covered by the concurrency tests.

### Codex read-only scout

- Verified local `codex-cli 0.144.1` supports `--output-schema`, `--json`,
  `--output-last-message`, read-only sandboxing, and thread IDs.
- `src/adapters/codex-worker.js` creates artifact directories, stores JSONL
  events directly, validates exact report fields/task identity, and preserves
  thread identity.
- `src/workflows/codex-scout.js` records dispatch intent, brief and digest,
  thread, report, and Firstmate verification events.
- The worker receives an empty `GH_CONFIG_DIR`; inherited `GH_TOKEN`,
  `GITHUB_TOKEN`, and `OPENAI_API_KEY` are removed.
- Firstmate independently verifies the leased worktree is still clean at the
  exact recorded SHA before accepting the report.
- A pending worker is reconciled from artifacts and never dispatched twice.

### Read-only GitHub gateway

- Added a fixed-operation `gh api --method GET` gateway with no mutating method.
- Normalizes repository, issue, branch protection, PR, check, review, and
  workflow-run observations.
- Exact-head status workflow re-reads the PR before recording evidence.
- Historical PRs #1 and #2 were recorded with successful required `test` checks.

### Local no-mistakes validation gate

- Pinned release and checksum details are owned by the
  [local validation gate guide](docs/local-validation-gate.md).
- Adapter always skips `rebase,push,pr,ci`, removes remote credentials, disables
  telemetry, and independently verifies Git before and after.
- Live run `01KXEEDJKSY306KE9RWK47XMWB` passed with no findings or SHA change.

### Restart reconciliation

- Added same-audit-ID idempotency and typed recovery audit events.
- Audits ledger, Treehouse, Git, workers, validation, and exact GitHub PR/check
  state without invoking recovery actions.
- Live Codex, GitHub, and validation histories all recorded `safeToResume: true`.
- A network-restricted same-ID GitHub retry proved observations were not repeated.

### Agents SDK authentication checkpoint

- Installed `@openai/agents` `0.13.2` and `zod` `4.4.3` from the official
  TypeScript quickstart.
- Confirmed `.env` is ignored, contains a non-empty `OPENAI_API_KEY`, and is not
  copied into worker environments or durable evidence.
- A minimal authenticated run against `gpt-5.6-luna` returned exactly `READY`.
- The run used reasoning effort `none`, a 16-token output cap, one maximum turn,
  tracing disabled, and response storage disabled.
- The API identified a concrete organization and project, but their identifiers
  were deliberately not written into repository documentation or task state.

### One-agent Firstmate shell

- Added `src/workflows/firstmate.js` and `scripts/firstmate.js`.
- The SDK agent has strict Zod input/output, one turn, no tools or handoffs,
  bounded output, disabled response storage, and configurable tracing with
  sensitive trace payloads disabled.
- The ledger records `firstmate.run.requested`, `.classified`, and `.failed`.
- Intent records contain a message digest and unique attempt claim, preventing
  same-ID retries and concurrent callers from spending twice.
- Uncertain intent fails closed; malformed output stores only sanitized failure
  evidence. Tests inject the runner and make no API calls.

### Codex MCP specialist

- Added `src/adapters/codex-mcp.js`, `src/tools/codex-scout-tool.js`, and
  `scripts/codex-mcp-scout.js`.
- A live stdio handshake with installed `codex-cli 0.144.1` verified exactly
  `codex` and `codex-reply`; ShipMates validates both schemas before every call.
- Firstmate receives strict `codex_scout` and `codex_scout_reply` function
  tools. Raw MCP tools are not model-visible and Codex is not a conversational
  handoff.
- New scout calls fix the durable worktree, read-only sandbox, and
  `approval-policy=never`; GitHub and OpenAI API credentials are stripped.
- Structured MCP thread content must contain strict report JSON. The sanitized
  result is atomic and independently reverified against Git.
- `CodexMcpRuntime.reply()` requires the exact thread and is wrapped in durable
  reply intent/result events plus artifact-only restart reconciliation.

## Completed live tasks

Operational histories are in the ignored `.shipmates/tasks/` directory.

`ledger-practice-001`:

- basic ledger exercise;
- state `clarified`;
- three events.

`treehouse-ledger-20260713`:

- ledger-backed no-mutation Treehouse lifecycle;
- state `complete`;
- 13 events;
- lease returned.

`codex-scout-20260713`:

- complete Treehouse plus read-only Codex scout lifecycle;
- state `complete`;
- 18 events;
- worker `scout-001` status `reported`;
- Codex thread `019f5cc0-e139-7220-9bc5-4909d84396a3`;
- report inspected `src/message.js` and `test/message.test.js`;
- reported five passing tests;
- independently verified no mutation at practice SHA
  `4894811cf35e6e7b6559d4d75f2da78d24791c92`;
- lease returned to `available`.

`codex-mcp-scout-20260713`:

- complete Treehouse plus read-only Codex MCP scout lifecycle;
- state `complete`; 19 events including restart audit;
- worker `scout-mcp-001` backend `codex-mcp`, status `reported`;
- Codex thread `019f5d07-561d-7f70-959e-161046e3f5cd`;
- report inspected four files and recorded five passing tests;
- exact practice SHA independently verified with no mutation;
- Treehouse lease returned to `available` after evidence-based recovery from a
  sandbox-interrupted first return attempt;
- audit `restart-live-codex-mcp-001` recorded `safeToResume: true`.

`github-read-20260713`:

- four events including a successful restart audit;
- PRs #1 and #2 retained exact heads and required checks;
- no GitHub mutation methods were exposed or invoked.

`local-validation-20260713`:

- three events including a successful restart audit;
- pinned no-mistakes run passed at unchanged practice SHA;
- remote-capable validation steps were skipped.

`parallel-mcp-scout-20260713`:

- complete Treehouse plus two-pane read-only Codex MCP lifecycle;
- state `complete`; 30 events including synthesis and its fresh restart audit;
- exact practice SHA `4894811cf35e6e7b6559d4d75f2da78d24791c92`
  independently verified without mutation for both successful reports;
- workers `scout-pane-left-v2` and `scout-pane-right-v2` ran concurrently in
  panes `w1:p2` and `w1:p3` with separate Codex threads;
- each scout reported five passing tests; one also recorded that Node's optional
  coverage temp output was blocked by the read-only sandbox after assertions
  passed;
- the first two worker IDs are preserved as failed history: the initial
  coordinator incorrectly treated Herdr's scheduling acknowledgement as process
  completion, so the subsequently started pane workers correctly rejected stale
  authority and made no Codex call;
- the corrected launcher waits for an atomic, identity-bound
  `pane-terminal.json` marker before evaluating artifacts;
- Treehouse has no retained worktree, panes `w1:p2` and `w1:p3` have no attached
  agents, and audit `restart-live-parallel-panes-001` recorded
  `safeToResume: true`;
- synthesis `pair-evidence-review-v1` is bound to the two successful report
  events and exact practice SHA with artifact digest
  `1452ec780f7d0307d93faeaca0a534047f68c6d54e9589582000196982f1da24`;
- synthesis outcome `review_required`: seven exact agreements, one different
  `npm test` result description, thirteen peer-uncorroborated claims, and
  fourteen deterministic follow-up checks;
- synthesis did not change task state or call any worker, pane, Treehouse,
  worktree, model, or GitHub operation;
- Herdr correctly showed the previous audit as stale after the new evidence;
  fresh audit `restart-live-synthesis-001` then recorded `safeToResume: true`.

Inspect the final snapshot with:

```sh
node scripts/task-ledger.js show codex-scout-20260713
node scripts/task-ledger.js show codex-mcp-scout-20260713
```

## Important implementation paths

```text
README.md
docs/architecture-strategy.md
docs/github-governance.md
docs/openai-and-tooling-architecture.md
docs/treehouse-integration.md
docs/task-ledger.md
docs/codex-worker.md
docs/codex-mcp-specialist.md
docs/github-draft-pr.md
docs/herdr-status.md
docs/parallel-readonly-scouts.md
docs/scout-synthesis.md
schemas/codex-worker-report.schema.json
schemas/scout-synthesis.schema.json
src/adapters/treehouse.js
src/adapters/codex-worker.js
src/adapters/codex-mcp.js
src/adapters/herdr-pane.js
src/adapters/github-read.js
src/adapters/github-draft-pr.js
src/core/task-state.js
src/storage/task-store.js
src/workflows/treehouse-ledger.js
src/workflows/codex-scout.js
src/workflows/parallel-codex-scouts.js
src/workflows/scout-synthesis.js
src/workflows/github-status.js
src/workflows/github-draft-pr.js
src/tools/codex-scout-tool.js
src/projections/herdr.js
scripts/task-ledger.js
scripts/treehouse-ledger.js
scripts/codex-scout.js
scripts/codex-mcp-scout.js
scripts/codex-mcp-pane-worker.js
scripts/codex-mcp-pair.js
scripts/scout-synthesis.js
scripts/github-draft-pr.js
scripts/herdr-status.js
test/
```

## OpenAI documentation setup

Codex is logged in using ChatGPT. The official developer-docs MCP server was
added globally:

```text
openaiDeveloperDocs  https://developers.openai.com/mcp  enabled
```

It was installed because the `openai-docs` skill's manual helper reached the
official site but rejected the response after the expected integrity header was
missing. Restart Codex so the new MCP server becomes callable. Do not change the
Codex version or authentication unless a later task explicitly requires it.

## Exact next stage: bounded synthesis follow-up

The deterministic Firstmate-owned synthesis gate is complete. It accepts only
two terminal, independently verified read-only scouts bound to the same task,
worktree path, and exact head. Its canonical atomic artifact preserves both
reports separately, records exact agreements/disagreements, labels unique prose
as peer-uncorroborated rather than false, proposes follow-up checks, and is bound
into the ledger by digest and source report events. Retry verifies and reuses the
artifact. It never advances task state or invokes an external capability. Herdr
shows only outcome/counts and detects stale recovery audits. The live synthesis
and fresh recovery audit above prove the path.

Next, add a human-selected, read-only follow-up gate for one proposed synthesis
check. Bind the selection to the synthesis event/digest, exact check identity,
worker evidence, task, and SHA. Prefer continuing an existing scout thread only
when the selected check requires interpretation; use deterministic local reads
for inspectable facts. Record intent before any model call, preserve crash-safe
artifact reconciliation, and record a typed resolution without rewriting the
original synthesis. Do not automatically execute all fourteen checks, edit the
practice repository, advance validation, or authorize any GitHub write.

Do not place an API key in the repository, worker worktrees, task ledger, or
terminal evidence. Do not broaden the draft-PR gateway, add mutating Herdr
behavior, or enable parallel mutating workers without a separately bounded stage.

## Routine verification commands

From `/Users/johnwilliams/MIT/Courses/ShipMates`:

```sh
node --test
git diff --check
git status --short --branch
```

From `/Users/johnwilliams/MIT/Courses/Shipmates-Practice`:

```sh
node --test
git status --short --branch
git rev-parse HEAD
```

Treehouse status:

```sh
PATH=/opt/homebrew/bin:$PATH \
HOME=/private/tmp/shipmates-treehouse-home \
TREEHOUSE_NO_UPDATE_CHECK=1 \
/private/tmp/treehouse-v2.0.0/treehouse status
```
