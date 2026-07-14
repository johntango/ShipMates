# Durable task ledger

ShipMates now stores task history as append-only JSONL and derives current state
by replaying that history. The event log is authoritative; `snapshot.json` is a
replaceable projection for humans and future status adapters.

## Storage layout

Run commands from the ShipMates repository root. Operational data is written
under the ignored `.shipmates/` directory:

```text
.shipmates/
  tasks/
    <task-id>/
      events.jsonl     authoritative event history
      snapshot.json    replayable current-state projection
      write.lock       present only while a writer owns the task
```

Each append takes an exclusive per-task filesystem lock, validates the proposed
history, atomically replaces the event log, and atomically replaces the
snapshot. Independent processes can write different events to one task without
losing updates.

The store never guesses through uncertainty:

- a malformed event log stops replay;
- an illegal or stale transition is rejected before writing;
- an existing lock is never stolen automatically;
- reusing an event ID with different content is rejected;
- retrying the same event ID and content is idempotent;
- a missing or damaged snapshot can be rebuilt from the event log.

## State machine

The normal path is:

```text
proposed -> clarified -> approved_for_dispatch -> preparing -> running
  -> awaiting_worker -> validating -> awaiting_human -> ready_to_merge
  -> merging -> landed -> cleaning -> complete
```

Some work can return from `awaiting_worker`, `validating`,
`awaiting_human`, or `ready_to_merge` to `running`. Any non-terminal state can
enter `blocked`, `failed`, `cancelled`, or `recovery_required`. Terminal and
exceptional states cannot be exited by an ordinary transition.

A verified no-mutation exercise uses the shorter cleanup branch
`running -> validating -> cleaning -> complete`; it has no pull request or
merge approval to await.

Every transition includes its expected `from` state. This optimistic check
prevents a delayed process from advancing a task whose state changed while it
was working.

## Operator exercise

From `/Users/johnwilliams/MIT/Courses/ShipMates`, create and inspect a practice
task:

```sh
node scripts/task-ledger.js create \
  ledger-practice-001 \
  code-change \
  johntango/Shipmates-Practice \
  4894811cf35e6e7b6559d4d75f2da78d24791c92

node scripts/task-ledger.js transition \
  ledger-practice-001 proposed clarified \
  "scope and acceptance criteria recorded"

node scripts/task-ledger.js evidence \
  ledger-practice-001 requirement \
  "exercise the durable ledger before worker integration"

node scripts/task-ledger.js show ledger-practice-001
node scripts/task-ledger.js events ledger-practice-001
```

Generic ledger events cannot authorize a merge. After a complete delivery task
has a ready, passing exact-head PR, use the compare-and-act approval workflow:

```sh
SHIPMATES_HUMAN_ACTOR=YOUR_NAME npm run firstmate:delivery -- \
  approve-merge TASK_ID MERGE_APPROVAL_ID
```

For isolated exercises or tests, redirect state outside the repository:

```sh
SHIPMATES_STATE_DIR=/tmp/shipmates-state \
  node scripts/task-ledger.js create task-001 code-change owner/repo BASE_SHA
```

## Recovery

If `snapshot.json` is absent or damaged but `events.jsonl` is valid, run:

```sh
node scripts/task-ledger.js rebuild TASK_ID
```

If `events.jsonl` is malformed, do not edit forward or run another mutating
command. Preserve the task directory and investigate the last durable file
operation; the ledger intentionally fails closed.

If a process dies while holding `write.lock`, subsequent writers time out. Check
the PID and acquisition time stored in the lock, prove that process no longer
exists, preserve a copy of the task directory, and only then remove the stale
lock manually. Automatic stale-lock reclamation is intentionally deferred until
we have a recovery protocol with stronger process-identity evidence.

## Current boundary

The Treehouse workflow appends typed lease request, lease result, proof, return
request, and return result events automatically. The Codex scout workflow adds
dispatch, thread, report, reply, and independent-verification events. Scout
follow-ups add a human selection bound to a synthesis artifact and a resolution
bound to one verified read-only reply. The approved draft-PR workflow adds human
approval, pre-write intent, confirmed result, and recovery events; CI
observations remain read-only. `.shipmates/` is local operational state and must
not contain credentials or replace GitHub as the authority for remote
repository facts.

Mutating workers reuse the worker lifecycle with `mode=ship` and
`sandbox=workspace-write`. Their terminal verification records the unchanged
commit and branch plus the exact staged, unstaged, and untracked path set. It is
not a no-mutation proof and does not authorize commit or publication.

The controlled commit stage adds `git.commit.requested` before staging and
`git.commit.completed` only after independent single-parent, identity, message,
tree, cleanliness, and changed-path verification. Completion advances the
active lease's authoritative head. The validation stage similarly records
`validation.local.requested` before invoking the pinned local-only gate and
binds its result to that exact head, branch, intent digest, and binary pin.

Branch publication adds `git.push.approved`, `git.push.requested`, and either a
confirmed `git.push.completed` or proven-absence `git.push.failed` event. The
approval is bound to one repository, new task branch, and full validated SHA.
Uncertain requested operations remain durable and must be reconciled remotely
without repeating the push.

Firstmate delivery mode adds no competing state store. It derives its stage
from these push events, the existing separately approved draft-PR events, and
`github.status.recorded` observations. CI evidence is accepted for delivery only
when the PR number and head match the completed draft operation's approved SHA.

Merge delivery adds `github.merge.approved` for one human-bound repository, PR,
head, default branch, and squash method. `github.merge.requested` consumes it
before mutation and moves the task to `merging`; confirmed or reconciled success
records `github.merge.completed` and moves to `landed`. A proven open-unmerged
result records `.failed`, returns to `awaiting_human`, and requires a new
approval. The legacy generic `task.approval.recorded` event is not accepted by
the merge gateway.

Post-merge completion records `github.post_merge.verified` only after the
confirmed merge commit is still the default-branch head and every protected or
pre-merge-required check passes on that commit. The subsequent
`worktree.proof.recorded` event must bind an `exact-tree-landing` proof to that
assurance event before `worktree.return.requested` can advance through
`cleaning` to `complete`. An uncertain return remains durable and is reconciled
without repeating Treehouse mutation.

Remote task-branch cleanup adds `git.branch_cleanup.approved`, `.requested`,
`.completed`, and `.failed`. Approval binds the exact published repository,
branch, head, assurance, tree-proof, and returned-lease events. Requested intent
consumes the approval before atomic deletion. An absent ref completes; the
original ref still present fails and requires new approval; a changed ref is
never accepted as either outcome.

The Herdr adapter reads the replaceable task snapshot and creates an ephemeral
operator projection. It never writes a status event back into the ledger; see
the [Herdr status guide](herdr-status.md).
