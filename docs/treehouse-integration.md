# Treehouse worktree integration

## Current learning slice

ShipMates now has a narrow `TreehouseWorktreeManager` adapter for:

- preparing a GitHub-backed repository for detached managed worktrees;
- acquiring a durable lease with a task ID as its holder;
- inspecting the leased worktree independently with Git;
- proving that a lease had no mutation;
- revalidating the proof immediately before returning the lease;
- refusing ambiguous CLI output, dirty worktrees, changed HEADs, or missing proof.

The adapter is in `src/adapters/treehouse.js`. It invokes commands with argument
arrays rather than an unrestricted shell string.

The ledger-backed workflow is in `src/workflows/treehouse-ledger.js`. It records
an intent before every Treehouse mutation and a result afterward. Deterministic
event IDs make safe retries idempotent.

## Pinned exercise dependency

The live exercise used upstream Treehouse `v2.0.0` for Darwin ARM64:

```text
archive: treehouse-v2.0.0-darwin-arm64.tar.gz
sha256:  66022f36eb0c79d6f242025f266b782ac947b3a2817005f13425cbd18874f1f9
```

The binary was downloaded to `/private/tmp` and was not added to this repository.
Production installation and upgrade policy remain a later decision.

## Git compatibility preflight

Treehouse `v2.0.0` uses:

```text
git rev-parse --path-format=absolute --git-common-dir
```

The `/usr/local/bin/git` version on the development Mac is `2.23.0` and
misparses that form inside linked worktrees. A compatible Git `2.55.0` is already
installed at `/opt/homebrew/bin/git`.

The adapter tests the required behavior directly before leasing. ShipMates must
launch Treehouse with `/opt/homebrew/bin` before `/usr/local/bin` in `PATH`; an
incompatible Git causes a refusal before a worktree is acquired.

## Verified exercise

The exercise used `Shipmates-Practice` at:

```text
38b1ad2ba7bdff30b351c8f7b0fc1ea6151296d7
```

Treehouse performed this lifecycle:

```text
available
  -> leased (holder: shipmates-treehouse-exercise-002)
  -> inspected: detached, clean, expected HEAD
  -> no-mutation proof created
  -> proof revalidated
  -> returned
  -> available
```

The primary checkout remained on `main` and was not used as the worker directory.

Run the no-mutation exercise with:

```sh
PATH=/opt/homebrew/bin:$PATH \
TREEHOUSE_BIN=/path/to/pinned/treehouse \
node scripts/treehouse-no-mutation-exercise.js \
  /absolute/path/to/Shipmates-Practice \
  shipmates-treehouse-exercise
```

If a process stops after acquiring a clean lease, recompute proof and recover it
with `scripts/treehouse-recover-no-mutation.js`.

## Mutating Codex exercise

Task `shipmates-mutating-001` completed the first mutating lifecycle:

```text
Treehouse lease at 38b1ad2
  -> Firstmate creates agent/treehouse-crew-summary
  -> sandboxed Codex edits two authorized files
  -> Firstmate independently tests and commits 1b6305d
  -> draft PR #2 and protected CI
  -> human approves exact head 1b6305d
  -> squash merge 4894811
  -> post-merge CI succeeds
  -> exact-tree proof 8feec02d
  -> Treehouse return
  -> available
```

The Codex worker used a workspace-write sandbox and an empty `GH_CONFIG_DIR`.
It could edit and test but could not publish to GitHub. Its configured
output-last-message file was not created, so Firstmate rejected the reporting
channel and reconstructed all evidence from Git and the test runner.

## Return proof types and limitations

The adapter accepts two proof types:

- `no-mutation`: clean worktree at the originally recorded HEAD;
- `exact-tree-landing`: clean worktree at the approved PR head, remote `main`
  equal to GitHub's reported squash commit, and identical Git trees for the
  approved head and squash commit.

`exact-tree-landing` deliberately refuses if another commit reaches `main` before
proof or if GitHub's merged tree differs from the approved tree. A later
reconciliation slice may add patch-based proof for concurrent, non-overlapping
main-branch changes, but it must not weaken the current fail-closed behavior.

Firstmate delivery now invokes this proof only after durable merge-commit CI
assurance. It fetches the confirmed full commit without updating a branch,
binds the proof to that assurance event, records return intent, and then calls
Treehouse. See the [post-merge assurance guide](post-merge-assurance.md).

## Ledger-backed lifecycle

Task `treehouse-ledger-20260713` exercised the integrated workflow at practice
commit `4894811cf35e6e7b6559d4d75f2da78d24791c92`:

```text
approved_for_dispatch
  -> preparing
  -> worktree.lease.requested
  -> Treehouse lease acquired and independently inspected
  -> worktree.leased
  -> running
  -> validating
  -> worktree.proof.recorded (no-mutation)
  -> cleaning
  -> worktree.return.requested
  -> Treehouse return
  -> worktree.returned
  -> complete
```

The resulting snapshot contains the repository path, worktree path, base and
head SHAs, lease request ID, lease result ID, proof ID, return request ID, and
return result ID. After replay, Treehouse reported the worktree `available`, and
the practice checkout remained clean at the expected commit.

From the ShipMates repository root, acquire and complete an already approved
no-mutation task with:

```sh
PATH=/opt/homebrew/bin:$PATH \
HOME=/private/tmp/shipmates-treehouse-home \
TREEHOUSE_NO_UPDATE_CHECK=1 \
TREEHOUSE_BIN=/private/tmp/treehouse-v2.0.0/treehouse \
node scripts/treehouse-ledger.js acquire TASK_ID \
  /Users/johnwilliams/MIT/Courses/Shipmates-Practice

PATH=/opt/homebrew/bin:$PATH \
HOME=/private/tmp/shipmates-treehouse-home \
TREEHOUSE_NO_UPDATE_CHECK=1 \
TREEHOUSE_BIN=/private/tmp/treehouse-v2.0.0/treehouse \
node scripts/treehouse-ledger.js complete-no-mutation TASK_ID
```

### Restart boundary

There is an unavoidable crash window between an external Treehouse mutation and
recording its result locally. ShipMates handles that window by refusing to issue
the mutation again.

If acquisition stopped after `worktree.lease.requested`, obtain the exact path
from `treehouse status`, then run:

```sh
node scripts/treehouse-ledger.js reconcile-acquire \
  TASK_ID /absolute/repository/path /absolute/worktree/path
```

Reconciliation succeeds only if Treehouse reports that exact path as `leased`
to the exact task ID and Git independently reports a clean worktree at the task
base SHA.

If return stopped after `worktree.return.requested`, run:

```sh
node scripts/treehouse-ledger.js reconcile-return TASK_ID
```

This succeeds only if the exact pool entry is now `available` with no lease
holder. If it is still leased, ShipMates leaves the task in `cleaning`; the
operator must inspect the worktree and decide whether a fresh proof and explicit
recovery action are safe. It never repeats an uncertain return automatically.
