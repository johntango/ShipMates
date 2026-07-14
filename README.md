# ShipMates

ShipMates is an experimental development orchestrator built around one rule:
the human talks only to the Firstmate, and the Firstmate delegates bounded work
to isolated crewmate agents.

We are developing the system incrementally so that isolation, GitHub authority,
approval gates, landed-work proof, and recovery are understood before
multi-agent concurrency is enabled. Each stage is exercised in the disposable
`johntango/Shipmates-Practice` repository before it becomes part of the permanent
orchestrator.

Start with the [staged architecture strategy](docs/architecture-strategy.md), then
read the [OpenAI and reference-tool architecture](docs/openai-and-tooling-architecture.md)
and [GitHub governance contract](docs/github-governance.md). The first executable
integration is documented in the [Treehouse worktree guide](docs/treehouse-integration.md).
The next executable component is the [durable task ledger](docs/task-ledger.md).
Read-only specialist execution is documented in the
[Codex worker guide](docs/codex-worker.md).
GitHub observations and exact-head evidence are documented in the
[read-only GitHub gateway guide](docs/github-read-gateway.md).
The local validator boundary is documented in the
[no-mistakes validation gate guide](docs/local-validation-gate.md).
Cross-system restart decisions are documented in the
[restart reconciliation guide](docs/restart-reconciliation.md).
The human-facing intake boundary is documented in the
[one-agent Firstmate shell guide](docs/firstmate-shell.md).
The bounded Codex MCP integration is documented in the
[Codex MCP specialist guide](docs/codex-mcp-specialist.md).
Human-selected synthesis checks are documented in the
[scout follow-up guide](docs/scout-follow-up.md).
Durable workspace-write execution is documented in the
[mutating Codex worker guide](docs/codex-ship.md).

## Current status

ShipMates is a working architecture experiment, not yet a finished autonomous
orchestrator. We have completed and tested one full controlled lifecycle:

```text
human request
  -> Treehouse lease
  -> bounded Codex worker
  -> independent Firstmate verification
  -> task commit and draft PR
  -> protected GitHub CI
  -> exact-SHA human approval
  -> protected squash merge
  -> post-merge CI
  -> exact-tree landed-work proof
  -> Treehouse return
  -> separately approved branch cleanup
```

Implemented repository artifacts include:

- a `TreehouseWorktreeManager` adapter;
- Git compatibility and lease-output validation;
- no-mutation and exact-tree landing proofs;
- recovery and exercise scripts;
- unit tests for fail-closed behavior;
- a structured Codex worker-report schema;
- an append-only task event ledger with replayable snapshots and cross-process
  locking;
- a restart-safe Treehouse-to-ledger workflow with typed intent/result events;
- a schema-validated, read-only Codex scout with durable thread and report
  artifacts;
- a capability-limited GitHub GET gateway with normalized repository, issue,
  branch-policy, PR, check, review, and workflow-run evidence;
- a pinned, local-only no-mistakes adapter that disables remote pipeline steps
  and records independently verified validation evidence;
- an idempotent read-only restart reconciler for ledger, Treehouse, Git, worker,
  validation, and GitHub state;
- an interactive Agents SDK Firstmate shell with automatic UUID-derived task
  and request IDs, strict typed classification, durable call intent, token
  evidence, and concurrent-call exclusion;
- a bounded local Firstmate executor that runs two independent read-only Codex
  scouts before local implementation and stops before external or destructive
  authority;
- a durable Treehouse-bound mutating-worker supervisor with crash-recoverable
  artifacts and exact staged, unstaged, and untracked path verification;
- a local Codex MCP runtime wrapped as one strict, read-only Firstmate scout
  tool with no conversational handoff;
- architecture and GitHub governance documentation;
- live, sanitized Herdr execution visibility for Firstmate scouts and the local
  implementation worker.

Crash-safe Codex thread continuation and exactly two concurrent read-only
scouts are implemented. A durable supervisor for mutating workers is still
planned work.

## How we developed ShipMates

### Step 1: Establish the authority boundary

We began with the rule that the human communicates only with Firstmate.
Crewmates receive bounded tasks and report evidence to Firstmate; they do not ask
the human for decisions and cannot merge or destroy work.

We separated five concepts that are often accidentally combined:

1. instructions tell an agent what procedure to follow;
2. tools provide executable capabilities;
3. credentials provide external authority;
4. the task brief limits what is authorized for one task;
5. human approval authorizes one sensitive transition.

This became the foundation of the
[architecture strategy](docs/architecture-strategy.md) and
[GitHub governance contract](docs/github-governance.md).

### Step 2: Study the reference repositories

We inspected four `johntango` forks and assigned each one a narrow role:

| Repository | ShipMates role |
| --- | --- |
| `firstmate` | Coordinator and worker-lifecycle reference |
| `treehouse` | Durable leased Git worktrees |
| `no-mistakes` | Future review, test, draft-PR, and CI gate |
| `lavish-axi` | Future optional visual review surface |

We decided not to copy all their features into ShipMates. Instead, ShipMates owns
policy, task state, approval, and reconciliation while narrow adapters invoke the
specialized tools. The inspected commits and upstream policy are recorded in
[OpenAI and reference-tool architecture](docs/openai-and-tooling-architecture.md).

### Step 3: Select the OpenAI orchestration model

We chose the OpenAI Agents SDK for the future human-facing Firstmate and Codex
for coding specialists. The intended topology is manager-style orchestration:
Firstmate invokes workers as tools and always retains ownership of the human
conversation.

Codex subscription authentication and Agents SDK API authentication were kept as
separate concerns. Local Codex workers can use ChatGPT sign-in, while the future
Agents SDK service will use an explicitly configured OpenAI Platform project.

### Step 4: Create a disposable GitHub practice repository

We created local and GitHub repositories named `Shipmates-Practice`. Before the
first commit, we verified that `.env` was ignored so credentials could not be
accidentally published.

The initial practice project included:

- a small Node.js module;
- Node's built-in test runner;
- a deterministic GitHub Actions workflow;
- an initial `main` branch and successful CI run.

This gave us a harmless target for testing authority and recovery controls.

### Step 5: Protect the GitHub default branch

We configured `main` so GitHub, rather than agent behavior alone, enforces the
workflow:

- pull requests are required;
- the `test` check must pass and be current;
- administrators are also subject to protection;
- force pushes and branch deletion are blocked;
- conversations must be resolved;
- zero reviewers are required during the single-human learning phase.

The worker does not receive administrative or merge authority.

### Step 6: Exercise the first protected pull request manually

The first task added an optional ship assignment to the practice message. We:

1. created `agent/first-protected-change`;
2. made and tested the change;
3. opened draft PR #1;
4. recorded its exact head SHA;
5. waited for required CI;
6. asked the human to approve that exact SHA and squash method;
7. re-read GitHub immediately before merge;
8. merged without administrator bypass;
9. verified the resulting `main` commit and post-merge CI.

Any new commit after approval would have invalidated the approval.

### Step 7: Learn why ordinary Git ancestry is insufficient

A squash merge creates a new commit, so the original task commit is not an
ancestor of `main`. A cleanup rule based only on `git merge-base --is-ancestor`
would incorrectly describe safely landed work as unlanded.

For the first exercise, we compared the task and merged Git trees. They were
identical, which proved all task content had landed. Only after that proof did the
human separately authorize local and remote task-branch deletion.

This directly shaped the later Treehouse return policy.

### Step 8: Build the Treehouse adapter

We added [the adapter](src/adapters/treehouse.js) instead of scattering
Treehouse commands throughout the orchestrator. It currently provides:

- `prepareRepository`;
- `lease`;
- `status`;
- `inspect`;
- `proveNoMutation`;
- `proveExactTreeLanding`;
- `returnLease`.

Commands use executable and argument arrays rather than unrestricted shell
strings. Lease output must contain exactly one absolute path. Returning a lease
requires a matching proof, and the worktree is re-inspected immediately before
Treehouse is invoked.

### Step 9: Test failure behavior before live mutation

The [adapter tests](test/treehouse.test.js) cover:

- durable task-holder arguments;
- noisy or ambiguous Treehouse output;
- incompatible Git behavior;
- clean no-mutation proof;
- refusal without proof;
- matching and mismatching squash trees;
- proof revalidation immediately before return;
- dirty or changed worktrees after proof.

The system is expected to refuse uncertain cleanup rather than make a best-effort
guess.

### Step 10: Discover and correct a real Git compatibility problem

The first live return safely failed. Treehouse `v2.0.0` needs:

```text
git rev-parse --path-format=absolute --git-common-dir
```

The shell selected `/usr/local/bin/git` version `2.23.0`, which misparsed that
command inside the linked worktree. A compatible Git `2.55.0` was already
installed at `/opt/homebrew/bin/git`.

We did not discard the failed lease. It stayed durably leased while we diagnosed
the problem. The adapter now checks the required Git behavior before acquiring a
worktree, and Treehouse is launched with `/opt/homebrew/bin` first in `PATH`.

### Step 11: Complete a no-mutation Treehouse lifecycle

Using pinned Treehouse `v2.0.0`, we ran:

```text
available
  -> leased with task holder
  -> detached, clean, expected HEAD verified
  -> no-mutation proof
  -> proof revalidation
  -> return
  -> available
```

The Treehouse release archive checksum and full exercise are documented in the
[Treehouse guide](docs/treehouse-integration.md).

### Step 12: Run a sandboxed Codex worker in a lease

For task `shipmates-mutating-001`, Firstmate leased a worktree at an exact base
SHA and created `agent/treehouse-crew-summary`. Codex then ran with:

- the leased directory as its only project root;
- workspace-write sandboxing;
- an empty `GH_CONFIG_DIR`;
- a two-file edit scope;
- explicit prohibitions on commit, push, merge, network access, deletion, and
  Treehouse return.

Codex added `crewSummary` and its tests. Firstmate independently verified that
only the two authorized files changed, ran all tests, and performed the commit
and GitHub publication itself.

### Step 13: Reject an unreliable worker status channel

Codex made the correct edits, but its configured output-last-message file was not
created. We did not treat the worker's “completed” status as proof.

Firstmate reconstructed the evidence from:

- `git status` and the exact diff;
- the branch and base SHA;
- the test runner;
- the unauthenticated worker GitHub profile;
- the final commit and GitHub state.

Repairing and testing this structured reporting channel is required before we
run multiple workers.

### Step 14: Complete the mutating Treehouse lifecycle

The verified change became draft PR #2. Required CI passed, and the human
approved exact head `1b6305d4686888293a28ef05f95031c4b51af1b5` for squash merge.

Firstmate then:

1. revalidated the head, checks, protection, worktree, and lease holder;
2. marked the PR ready;
3. squash-merged without bypass or branch deletion;
4. verified merge commit `4894811cf35e6e7b6559d4d75f2da78d24791c92`;
5. waited for post-merge CI;
6. verified remote `main` still pointed to that merge commit;
7. proved the approved and merged trees both equaled
   `8feec02de532187bea95e2e02a8f1ab28d4d72ad`;
8. revalidated the unchanged leased worktree;
9. returned the Treehouse lease to `available`;
10. obtained separate human approval before deleting the task branches.

This is the first complete evidence-backed ShipMates lifecycle.

### Step 15: Add the durable task ledger

We implemented the first persistent Firstmate-owned state component before
adding autonomous orchestration. Each task now has an authoritative append-only
JSONL event history and a current snapshot rebuilt by deterministic replay.

The ledger adds:

- explicit, validated lifecycle transitions;
- optimistic `from`-state checks against stale writers;
- idempotent event IDs;
- atomic event-log and snapshot replacement;
- per-task locks shared by independent processes;
- fail-closed behavior for corrupt history or uncertain lock ownership;
- snapshot reconstruction from the authoritative log.

The tests launch eight separate Node processes against one task to prove that
concurrent appends are serialized without losing events. Operating commands and
recovery boundaries are in the [task ledger guide](docs/task-ledger.md).

### Step 16: Connect Treehouse to the ledger

We replaced end-of-script-only Treehouse reporting with a durable workflow. It
records an intent before lease or return, validates the external result, and
then records that result with deterministic event IDs.

This matters at the two crash windows where Treehouse may have changed but the
local result event may not yet exist. On restart, ShipMates refuses to repeat the
uncertain action. Acquisition recovery requires the exact path to be leased to
the exact task holder and clean at the task base SHA. Return recovery requires
the exact pool entry to be available with no holder.

The live `treehouse-ledger-20260713` exercise produced 13 replayable events and
completed at the expected practice SHA. The lease returned to `available`, and
the primary practice checkout remained clean. Commands and recovery procedures
are documented in the [Treehouse guide](docs/treehouse-integration.md).

### Step 17: Repair and persist Codex worker reporting

We reproduced structured reporting with the installed `codex-cli 0.144.1` and
confirmed that output schema, JSONL events, thread identity, and last-message
files work when the artifact directory exists before launch.

The new scout runtime writes Codex events directly to durable storage, validates
the report against the task and schema, records the thread ID, and independently
re-inspects Git before accepting the worker claim. It also strips inherited
GitHub and OpenAI API tokens and assigns the worker an empty GitHub CLI profile.

The live `codex-scout-20260713` exercise recorded thread
`019f5cc0-e139-7220-9bc5-4909d84396a3`, two inspected files, five passing tests,
and an independently verified no-mutation result. The task produced 18 events,
reached `complete`, and returned its lease. See the
[Codex worker guide](docs/codex-worker.md).

### Step 18: Build the one-agent Firstmate shell

We added the first executable Agents SDK orchestration boundary. Firstmate has
strict Zod input and output contracts, no tools or handoffs, a single-turn cap,
bounded model settings, optional non-sensitive tracing, and disabled response
storage.

Each model call is preceded by a durable ledger intent containing a message
digest and unique attempt claim. Same-ID retries return the durable result,
concurrent callers cannot both reach the API, and an interrupted request fails
closed for reconciliation. Tests inject the runner and make no live calls. See
the [Firstmate shell guide](docs/firstmate-shell.md).

### Step 19: Put the Codex scout behind MCP

We replaced the scout's direct-process boundary with a local stdio MCP adapter
that verifies the installed `codex` and `codex-reply` schemas, fixes read-only
authority, strips API and GitHub credentials, validates structured thread
content, and writes only a sanitized durable result artifact.

Firstmate sees one custom `codex_scout` function tool, not the raw MCP server and
not a handoff. The live practice task completed five tests, preserved the exact
SHA, returned its Treehouse lease, and passed restart reconciliation. See the
[Codex MCP specialist guide](docs/codex-mcp-specialist.md).

### Step 20: Make Codex thread continuation crash-safe

Codex scout follow-ups now have durable requested/completed/failed events,
immutable thread and lease bindings, prompt digests, atomic per-reply artifacts,
idempotent completed results, and restart reconciliation that never repeats an
uncertain `codex-reply` call. Firstmate can receive the separate bounded
`codex_scout_reply` tool without receiving the raw MCP server or a handoff.

### Step 21: Gate draft-PR creation and observe CI

The only GitHub write gateway now creates an open draft PR from an already
pushed, locally validated task branch. A human approval binds the exact
repository, branches, head SHA, and title/body digests. Intent is durable before
the POST, success requires a confirming read, and interrupted writes reconcile
against GitHub without repeating creation. CI observation uses the existing
read-only exact-head workflow. See the
[approved draft-PR guide](docs/github-draft-pr.md).

### Step 22: Project authoritative state into Herdr

Herdr now has deterministic JSON and compact terminal projections for task,
worktree, worker/reply, validation, draft-PR/CI, approval, and recovery state.
The projector receives only `getSnapshot()`, excludes prompts and report prose,
and cannot advance a workflow. A live local task projection left both ledger
files byte-for-byte unchanged. See the
[Herdr status guide](docs/herdr-status.md).

### Step 23: Run two read-only scouts in verified Herdr panes

Firstmate can now reserve exactly two idle, unbound Herdr panes and launch one
artifact-only Codex MCP scout in each. Pane IDs are durable worker identity,
both dispatch intents precede launch, the scouts run concurrently, and each
report receives its own exact-SHA no-mutation verification. Restart recovery can
accept one completed artifact while preserving the other worker and pane as
uncertain without relaunching it. See the
[parallel scout guide](docs/parallel-readonly-scouts.md).

The live task `parallel-mcp-scout-20260713` completed with separate scouts in
`w1:p2` and `w1:p3`, five passing tests reported by each, an unchanged practice
SHA, returned Treehouse authority, released pane agents, and a restart-safe
audit. The exercise also established that `herdr pane run` acknowledges
scheduling rather than completion, so terminal state is now proven by an atomic
worker marker instead of the scheduling response.

### Step 24: Synthesize the two verified reports

Firstmate can now create a deterministic, artifact-backed comparison of exactly
two terminal read-only scout reports. It preserves each source separately,
records exact agreements and disagreements, labels unique claims as
peer-uncorroborated rather than false, and proposes bounded follow-up checks.
The ledger binds the artifact digest and source report events; retries verify and
reuse it. Synthesis never changes task state or invokes workers, Treehouse,
Herdr panes, validation, or GitHub. Herdr displays only its outcome and counts
and now marks a restart audit stale when later evidence is appended. See the
[synthesis guide](docs/scout-synthesis.md).

### Step 25: Run one human-selected read-only follow-up

A human can now select one exact proposed check from a bound synthesis and
continue either source scout through the existing crash-safe Codex MCP reply
path. The selection binds the synthesis event, artifact digest, check digest,
leased SHA, worker thread, reply ID, and prompt digest before execution. The
result is independently verified for no mutation and recorded by reply event
and report digest. See the [scout follow-up guide](docs/scout-follow-up.md).

### Step 26: Supervise one durable mutating worker

Firstmate local-write tasks now acquire a task-bound Treehouse lease before
execution and delegate implementation to one durable `workspace-write` Codex
worker. Dispatch intent precedes execution, artifacts support crash
reconciliation, and Firstmate independently proves that the worker did not
commit or change branches and that Git's exact changed-path set matches the
structured report. Verified uncommitted changes remain in the lease for the
next commit and validation stage. See the
[mutating worker guide](docs/codex-ship.md).

## Running the current checks

Run the ShipMates tests after `npm install`:

```sh
npm test
```

Pull requests run the same test command in GitHub Actions. The workflow also
checks the complete pull-request diff for whitespace errors.

Exercise the ledger from this repository root:

```sh
node scripts/task-ledger.js create \
  ledger-practice-001 code-change johntango/Shipmates-Practice BASE_SHA
node scripts/task-ledger.js show ledger-practice-001
```

The local ledger is written to the ignored `.shipmates/` directory. See the
[ledger guide](docs/task-ledger.md) before recovering a damaged log or stale
lock.

Run the no-mutation Treehouse exercise with a pinned Treehouse binary:

```sh
PATH=/opt/homebrew/bin:$PATH \
TREEHOUSE_BIN=/path/to/pinned/treehouse \
node scripts/treehouse-no-mutation-exercise.js \
  /absolute/path/to/Shipmates-Practice \
  shipmates-treehouse-exercise
```

The exercise scripts intentionally leave uncertain leases in place. Use the
recovery script only after independently proving the worktree is clean and still
at its expected head.

## Important current limitations

- Firstmate classifies one request and executes bounded read-only or local-write
  work, but it does not yet continue a multi-turn human conversation. Local
  writes now use one durable Treehouse-bound Codex worker; the two preliminary
  scouts still use the direct local runtime rather than the MCP-backed pane
  workflow.
- Agents SDK authentication was verified separately; routine tests do not call
  the API.
- The legacy direct Codex adapter remains for comparison; the current bounded
  scout also runs through `codex mcp-server`.
- Treehouse is pinned in `/private/tmp` for exercises, not installed or managed
  as a production dependency.
- Exact-tree proof refuses concurrent changes to `main`; patch-based
  reconciliation is future work.
- The draft-PR gateway does not push branches, update PRs, rerun workflows, mark
  PRs ready, comment, merge, or delete anything. Its live write path has not
  been exercised in this stage.
- no-mistakes and lavish-axi review are not yet wired into the full executable
  path. Herdr now receives best-effort live worker status in addition to its
  deterministic read-only projection, but it remains non-authoritative.
- Mutating-worker concurrency remains deliberately disabled; the only parallel
  path is exactly two read-only scouts.
- Synthesis is exact and deliberately non-semantic. Similar claims with
  different wording remain peer-uncorroborated until a bounded follow-up check
  or human review resolves them.

## Next development steps

The next sequence is:

1. add a Firstmate-controlled Git commit stage for the verified changed paths,
   then run the pinned local-only no-mistakes gate against that exact commit
   before requesting any publishing authority.

We will keep using `Shipmates-Practice` for each stage and will not advance a
sensitive transition without exact evidence and explicit human approval.
