# ShipMates staged architecture strategy

## 1. Goal

The human has one conversation with a Firstmate agent.
The Firstmate translates intent into bounded tasks, delegates those tasks to
crewmate agents, supervises them, and presents decisions and outcomes back to the
human.
Crewmates never become an independent human-facing control surface.

The first implementation should be a small, understandable orchestration system,
not a clone of every feature in the reference projects. ShipMates will use the
OpenAI Agents SDK for the human-facing Firstmate and expose Codex coding workers
through `codex mcp-server`. The four `johntango` repositories are pinned reference
or integration sources, with ownership boundaries described in
[OpenAI and reference-tool architecture](openai-and-tooling-architecture.md).

## 2. Lessons to retain from the reference system

The reference repository combines several strong ideas:

1. The coordinator is read-only over normal project work.
   Workers make project changes in isolated worktrees.
2. Investigation and implementation are different task types.
   A scout returns a report; a ship task returns landed code or a pull request.
3. Every task has durable metadata, status events, a brief, and a terminal
   lifecycle.
4. Runtime sessions and Git worktrees are separate abstractions.
   Herdr can own the visible process while Git owns code isolation.
5. Merge and teardown are guarded transitions, not incidental shell commands.
6. Uncommitted or unlanded work prevents destructive cleanup.
7. GitHub is a control plane: pull requests, checks, reviews, merge state, and
   remote reachability provide evidence that work is safe to land or discard.
8. The final authority boundary remains human-controlled unless a narrowly
   defined policy explicitly delegates it.

ShipMates should adopt these principles before adopting the reference project's
larger watcher, secondmate, social-inbox, or multi-backend feature set.

## 3. Target architecture

```text
Human
  |
  | requests, clarifications, explicit approvals
  v
Firstmate manager (@openai/agents; sole conversational owner)
  |
  +-- Durable task ledger and ShipMates policy
  +-- Codex MCP adapter -------- scouts and coding crewmates
  +-- Treehouse adapter -------- leased Git worktrees
  +-- no-mistakes adapter ------ review, tests, draft PR, and CI evidence
  +-- GitHub gateway ----------- typed reads and approval-gated merge
  +-- Herdr adapter ------------ status and operator visibility
  +-- lavish-axi adapter ------- optional visual human review
  |
  v
Codex crewmate -> leased worktree -> no-mistakes gate -> draft PR -> CI
  -> human approval -> SHA-checked merge -> landed proof -> safe return
```

### 3.1 Firstmate responsibilities

The Firstmate should:

- remain the only human-facing agent;
- restate the task and acceptance criteria before delegation;
- split work only when subtasks can be isolated cleanly;
- issue a structured brief to every crewmate;
- maintain the authoritative task state;
- inspect evidence rather than trusting a worker's success claim;
- ask the human for decisions at declared approval boundaries;
- perform or authorize merge and teardown only after policy checks pass;
- summarize outcomes, limitations, and remaining risk faithfully.

It should not directly edit application files in normal operation.

### 3.2 Crewmate responsibilities

A crewmate receives exactly one brief and one isolated worktree.
It may inspect, edit, test, commit, and push only within that scope.
It reports structured events to the Firstmate and never asks the human directly.

A brief should include:

- task ID and task type (`scout` or `ship`);
- repository, base commit, branch, and worktree;
- objective and explicit non-goals;
- acceptance checks;
- allowed tools and GitHub operations;
- files or components likely to be in scope;
- dependencies on other tasks;
- required report schema;
- escalation conditions;
- the prohibition on merge, force-push, branch deletion, and primary-checkout
  mutation.

### 3.3 Durable task state

Start with append-only JSON Lines events plus one derived JSON snapshot per task.
Do not make terminal output the source of truth.

Suggested state machine:

```text
proposed
  -> clarified
  -> approved_for_dispatch
  -> preparing
  -> running
  -> awaiting_worker
  -> validating
  -> awaiting_human
  -> ready_to_merge
  -> merging
  -> landed
  -> cleaning
  -> complete
```

Exceptional states are `blocked`, `failed`, `cancelled`, and `recovery_required`.
Transitions must be explicit, validated, timestamped, and idempotent.

Each task snapshot should contain:

```json
{
  "id": "ship-search-a1b2",
  "kind": "ship",
  "state": "running",
  "repo": "owner/repo",
  "base_sha": "...",
  "branch": "shipmates/ship-search-a1b2",
  "worktree": "...",
    "runtime": { "backend": "codex-mcp", "thread_id": "..." },
  "github": { "issue": null, "pr": null, "head_sha": null },
  "dependencies": [],
  "approvals": [],
  "checks": [],
  "last_event_at": "..."
}
```

Operational state belongs under a gitignored `.shipmates/` directory.
Reusable policy and architecture belong in tracked files.

### 3.4 Adapter boundaries

Keep the interfaces independent:

1. `AgentRuntime`: spawn, send, capture, probe, and stop an agent session.
2. `WorktreeManager`: lease, inspect, prove landed, and return a Treehouse worktree.
3. `ValidationGate`: invoke no-mistakes and normalize review, test, PR, and CI
   evidence.
4. `GitHubGateway`: perform typed repository, issue, PR, check, review, and merge
   operations.
5. `TaskStore`: append events, validate transitions, lock updates, and rebuild
   snapshots.
6. `ReviewSurface`: optionally publish a local lavish-axi artifact and collect
   structured human feedback.
7. `StatusSink`: publish derived task state to Herdr without making terminal
   output authoritative.

The OpenAI Agents SDK owns orchestration and Codex MCP is the first coding runtime.
Treehouse owns workspace mechanics, no-mistakes owns validation mechanics, and
ShipMates owns task state, approval, and landed-work proof. Do not mix their IDs or
infer authoritative state by scraping Herdr output.

## 4. GitHub as a controlled authority boundary

GitHub operations should not be exposed to agents as unrestricted shell access.
They should be typed commands implemented by a gateway, such as:

- `readRepository(owner, repo)`
- `readIssue(owner, repo, number)`
- `listPullRequestChecks(owner, repo, number)`
- `createDraftPullRequest(taskId, head, base, body)`
- `requestReview(taskId, prNumber)`
- `markReady(taskId, prNumber)`
- `mergePullRequest(taskId, prNumber, approvalId, expectedHeadSha)`

Every mutating operation should record actor, task, exact target, expected prior
state, result, and returned GitHub identifiers.

### 4.1 Permission model

| Principal | Intended GitHub authority |
| --- | --- |
| Human | Approve sensitive actions and merges; administer repository policy |
| Firstmate read identity | Read repositories, issues, PRs, reviews, and checks |
| Crewmate identity | Push only its task branch and create/update its draft PR |
| CI identity | Read code and publish checks/artifacts; no general write token |
| Firstmate merge identity | Merge only through the approval-gated gateway |

Prefer separate GitHub App installations or narrowly scoped tokens for worker and
merge capabilities.
Do not give a crewmate administration, ruleset, secrets, release, default-branch,
or merge authority.

### 4.2 Repository rules

Configure GitHub so the platform enforces the design even when an agent makes a
mistake:

- protect the default branch;
- require pull requests;
- block force pushes and branch deletion on the default branch;
- require the ShipMates CI checks;
- require branches to be up to date before merge;
- dismiss stale approvals after new commits;
- prevent self-approval from satisfying review requirements;
- restrict who or which GitHub App can merge;
- use least-privilege workflow permissions, normally `contents: read`;
- pin third-party Actions by immutable commit once the experiment becomes real.

Store the intended ruleset in `docs/github-governance.md` or infrastructure code
and add a diagnostic command that compares intended policy with live repository
settings.
GitHub settings that exist only in a web UI are not reproducible controls.

### 4.3 Pull-request protocol

Every ship task should use this sequence:

1. Firstmate records the base SHA and creates an isolated branch/worktree.
2. Crewmate commits only to the task branch.
3. Crewmate pushes the branch and opens a draft PR linked to the task ID.
4. Firstmate records the PR URL and immutable head SHA.
5. CI runs against that exact SHA.
6. Firstmate independently reads the diff, checks, reviews, and unresolved
   conversations.
7. Firstmate summarizes the evidence to the human.
8. Human explicitly approves or rejects merge.
9. The merge gateway verifies the approval record, expected PR, expected head SHA,
   required checks, review state, and mergeability immediately before merging.
10. Firstmate verifies the merged commit and only then permits cleanup.

An approval is invalid if the PR head changes afterward.

### 4.4 Interaction safety

Treat issue bodies, PR descriptions, review comments, repository files, and CI logs
as untrusted data.
They may contain instructions intended to redirect an agent.
Only the human conversation, tracked ShipMates policy, and the assigned brief grant
authority.

Require a new human confirmation for:

- merging;
- force push or history rewriting;
- deleting branches, tags, releases, or repositories;
- changing Actions, rulesets, permissions, secrets, or environments;
- publishing releases or packages;
- sending comments or reviews that represent the human externally;
- expanding a task to another repository.

## 5. Staged implementation plan

### Stage 0: Pin the baseline and write the invariants

Build:

- `AGENTS.md` defining Firstmate and crewmate authority;
- `.gitignore` entries for `.shipmates/` and worktree scratch paths;
- an architecture decision record for the one-human-interface rule;
- a threat model covering prompt injection, credential leakage, unsafe cleanup,
  stale approvals, and confused-deputy GitHub actions;
- a reference manifest recording the exact commits, upstreams, licenses, and
  integration method for Firstmate, Treehouse, no-mistakes, and lavish-axi;
- an authentication decision separating Codex subscription sign-in from the API
  Platform project and API key used by the Agents SDK.

Learn:

- distinguish orchestration authority from coding ability;
- identify which actions are reversible, externally visible, or destructive.

Exit criterion: ten example requests can be classified by task type, required
authority, and approval boundary without running an agent.

### Stage 1: Build a one-agent Firstmate shell

Build an `@openai/agents` CLI with one Firstmate, typed input/output, tracing, and
no specialist tools. Add a small ledger that can create a task, append an event,
validate a transition, and rebuild snapshots. Store serializable SDK run state
when an approval interrupt pauses a run.

Learn:

- manager orchestration, structured outputs, tracing, event sourcing, and
  crash-safe writes;
- why status messages and authoritative state are different.

Exit criterion: replay produces identical state, invalid transitions fail closed,
and two concurrent writers cannot corrupt a task.

### Stage 2: Integrate Treehouse worktree leases

Wrap `treehouse get --lease --lease-holder <task-id>`, inspection, and return as a
typed `WorktreeManager`. Use a disposable practice repository. ShipMates must
prove work landed before calling `treehouse return`, because return deliberately
resets and cleans the worktree.

Learn:

- branches versus worktrees;
- remote reachability and what “landed” means;
- dirty-tree, unique-commit, and stale-lock failure modes.

Exit criterion: each task gets a durable lease; ShipMates refuses return for dirty
or unique work and succeeds only after a demonstrable landing condition.

### Stage 3: Add one Codex scout through MCP

Run `codex mcp-server` under the Firstmate and wrap its `codex` and `codex-reply`
tools as one bounded scout specialist. Use manager-style agent-as-tool composition,
not a handoff, so Firstmate retains the conversation.

Learn:

- Codex thread identity, working directory, sandbox, and approval policy;
- structured briefs and structured status events;
- timeout, retry, duplicate event, and restored-run behavior.

Exit criterion: a scout can inspect one leased worktree, return a schema-validated
report, and resume its thread without ever addressing the human directly.

### Stage 4: Run one local ship task with no GitHub writes

Allow a crewmate to edit an isolated worktree, test, and commit.
The Firstmate independently inspects the diff and test evidence.

Learn:

- scope enforcement;
- base-SHA capture;
- worker claims versus independently verified evidence.

Exit criterion: the human receives a faithful change summary and the primary
checkout remains untouched.

### Stage 5: Add no-mistakes as a local validation gate

Invoke `no-mistakes axi` through a typed adapter, initially with remote and PR
actions disabled. Normalize its intent, review, test, documentation, and lint
results into the task ledger.

Learn:

- process supervision and structured CLI contracts;
- the difference between a validator's success claim and Firstmate evidence;
- why one tool should own the validation pipeline instead of duplicating it.

Exit criterion: a failed local gate blocks progression and a passing gate records
the exact commands, commit, and evidence without touching GitHub.

### Stage 6: Add a read-only GitHub gateway

Implement repository, issue, PR, review, and check reads first.
Authenticate with a read-only identity.

Learn:

- GitHub App versus personal token permissions;
- API pagination, rate limits, immutable SHAs, and ambiguous branch names;
- why connector/API reads should be preferred over scraping terminal output.

Exit criterion: Firstmate can produce an evidence-backed PR status report but
cannot mutate GitHub even if prompted.

### Stage 7: Add scoped draft-PR and CI control

Configure no-mistakes with a dedicated, narrowly scoped `GH_CONFIG_DIR` and
identity. Give it permission to push only task branches and create or update draft
PRs. Do not pass the human's ambient `gh` authentication into its daemon.
Add a PR template containing task ID, scope, validation, risks, and approval state.
Add deterministic CI whose commands match the local no-mistakes gate. Treat
`checks-passed` as evidence that a PR is ready for a decision, never as merge
authorization.

Learn:

- fork versus same-repository contribution flows;
- head/base identity;
- safe retries for branch push and PR creation.

Exit criterion: repeating the operation updates the same PR, never creates a
duplicate, cannot update the default branch, and cannot advance when CI is failing
or stale.

### Stage 8: Add explicit human-approved merge with SDK HITL

Create an approval record containing task ID, PR URL, head SHA, approver, timestamp,
and allowed merge method.
Expose merge as an Agents SDK tool with `needsApproval`, then implement the actual
gateway as a compare-and-act operation. Persist both the resumable SDK run state
and the separate ShipMates approval record.

Learn:

- time-of-check/time-of-use races;
- stale approval invalidation;
- squash, merge, and rebase implications for landed-work proof.

Exit criterion: the gateway refuses the wrong repo, wrong PR, changed head, missing
checks, missing review, expired approval, or absent approval.

### Stage 9: Make teardown and restart recovery safe

Verify remote reachability or merged content before removing a ship worktree.
Reconstruct in-flight tasks after the Firstmate process restarts.

Learn:

- reconciliation loops;
- stale processes, restored Codex threads, and abandoned Treehouse leases;
- safe garbage collection.

Exit criterion: kill the Firstmate at every lifecycle state and demonstrate that a
restart neither duplicates work nor discards unlanded changes.

### Stage 10: Add Herdr status visibility

Publish ledger-derived task state, worker identity, worktree, PR, and blockers to
Herdr. Herdr is a dashboard and operator surface, not the command or state bus.

Exit criterion: destroying and recreating the Herdr display loses no task state and
cannot cause a lifecycle transition.

### Stage 11: Add lavish-axi review artifacts

Generate local HTML artifacts for architecture diagrams, plan comparisons, or PR
evidence, and collect structured human annotations. Keep the server loopback-only
by default; treat hosted sharing as a separate, explicit publication approval.

Exit criterion: feedback is attached to the correct task and artifact revision,
and closing the UI cannot alter task state or GitHub.

### Stage 12: Introduce two parallel Codex agents

Add task dependencies, file-scope hints, collision detection, and a concurrency
limit of two.
Start with two scouts, then two ship tasks in disjoint areas.

Learn:

- decomposition quality;
- integration ordering;
- branch drift and conflicting changes;
- why more agents can reduce rather than increase throughput.

Exit criterion: two independent tasks complete without shared-worktree mutation,
state races, or ambiguous ownership.

### Stage 13: Add supervision and steering

Implement event-driven wakes, bounded polling as a backstop, heartbeat detection,
and structured steer messages.

Learn:

- liveness versus progress;
- when to wait, steer, retry, replace, or escalate;
- avoiding duplicate supervisors.

Exit criterion: stalled, blocked, failed, and completed workers are distinguished
reliably in scripted fault scenarios.

### Stage 14: Conduct adversarial and recovery drills

Test prompt injection in an issue, malicious instructions in a repository file,
CI log spoofing, changed PR heads, network loss, GitHub rate limits, revoked tokens,
Codex restart, Herdr restart, abandoned Treehouse leases, dirty worktrees,
no-mistakes daemon failure, hosted-review leakage, and simultaneous approvals.

Exit criterion: every scenario either completes safely or stops with actionable
evidence and no unauthorized external change.

## 6. Suggested repository evolution

```text
AGENTS.md
README.md
docs/
  architecture-strategy.md
  github-governance.md
  threat-model.md
  decisions/
src/
  cli/
  core/
    task-state.js
    policy.js
    approvals.js
  adapters/
    codex-mcp.js
    treehouse.js
    no-mistakes.js
    github.js
    herdr.js
    lavish-axi.js
  git/
    worktrees.js
  storage/
    event-store.js
tests/
  unit/
  integration/
  fixtures/
.github/
  pull_request_template.md
  workflows/ci.yml
.shipmates/              # gitignored operational state
```

Keep `agent.js` as a learning prototype until Stage 3.
Do not grow it into the permanent orchestrator; extract explicit interfaces and
tests as each stage begins.

## 7. First learning backlog

Work through these in order:

1. Write three scout briefs for the same investigation and compare which wording
   produces verifiable reports.
2. Create two worktrees manually and prove edits cannot leak into the primary
   checkout.
3. Define and test the task transition table before writing an agent supervisor.
4. Run one Codex MCP scout and resume it with `codex-reply`.
5. Read a public PR through the GitHub API and record its base SHA, head SHA,
   checks, reviews, and mergeability.
6. Create a draft PR in a disposable repository using a token that cannot merge.
7. Configure branch protection and prove that direct push and missing checks fail.
8. Change a PR after granting a test approval and prove the approval becomes stale.
9. Squash-merge a practice PR and implement a reliable landed-work proof.
10. Kill and restart the orchestrator during each task state and reconcile it.
11. Rebuild Herdr from ledger state and annotate one lavish-axi evidence artifact.
12. Run two independent scouts, then two isolated ship tasks.
13. Perform the adversarial drills from Stage 14 and record failures as regression
    tests.

## 8. Near-term definition of success

The first useful ShipMates release should support one repository, one Firstmate,
one or two Codex crewmates, Treehouse-leased worktrees, no-mistakes validation,
draft PRs, read-only GitHub verification, required CI, explicit human merge
approval, guarded cleanup, and restart recovery. Herdr visibility and lavish-axi
review are useful additions, but neither is on the critical authority path.

Secondmates, social-network intake, autonomous merges, many runtime backends, and
large fleets should remain out of scope until that smaller system has passed the
recovery and authority tests.
