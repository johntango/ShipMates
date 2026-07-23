# ShipMates Codex handoff

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

- Pinned upstream `v1.41.1` at source commit `4a692bd`.
- Darwin ARM64 archive SHA-256:
  `5ad446564458134db795876671fc50dbab379ae2284c9bc9fe4f4d7160b2f025`.
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
