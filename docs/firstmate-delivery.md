# Firstmate delivery continuation

The delivery continuation resumes an already validated local-write task without
reclassifying the request or dispatching another worker. It derives the exact
repository, task branch, and committed SHA from the durable ledger, then
coordinates the existing push, draft-PR, and read-only CI workflows.

Push and draft-PR creation remain separate authority boundaries. Each requires
its own human approval ID and exact binding. CI observation is read-only and
does not authorize merge.

## Inspect the next safe action

```sh
npm run firstmate:delivery -- status TASK_ID
```

The reported stage is one of:

- `awaiting_push_approval` or `ready_to_push`;
- `push_reconciliation_required`;
- `awaiting_draft_pr_approval` or `ready_to_create_draft_pr`;
- `draft_pr_reconciliation_required`;
- `awaiting_ci_observation` or `ci_pending_or_failed`;
- `awaiting_pr_ready`, `awaiting_merge_approval`, or `ready_to_merge`;
- `merge_reconciliation_required` or `landed`.

The same commands are available through
`npm run firstmate -- --delivery ...`. Delivery mode reads an existing task and
does not wait for a new task prompt.

## Approve and publish the exact task branch

```sh
SHIPMATES_HUMAN_ACTOR=YOUR_NAME npm run firstmate:delivery -- \
  approve-push TASK_ID PUSH_APPROVAL_ID

npm run firstmate:delivery -- \
  push TASK_ID PUSH_OPERATION_ID PUSH_APPROVAL_ID
```

The coordinator supplies the ledger-bound repository, branch, and SHA to the
[exact-head push workflow](exact-head-push.md). If transport becomes uncertain,
do not run `push` again:

```sh
npm run firstmate:delivery -- \
  reconcile-push TASK_ID PUSH_OPERATION_ID
```

## Separately approve and create the draft PR

Prepare UTF-8 title and body files, then record the second human approval:

```sh
SHIPMATES_HUMAN_ACTOR=YOUR_NAME npm run firstmate:delivery -- \
  approve-pr TASK_ID PR_APPROVAL_ID main TITLE_FILE BODY_FILE
```

Creation re-reads GitHub and requires `main` to still be the repository's
default branch. It confirms the exact remote head, records write intent, creates
one draft PR, confirms it by read, and immediately performs a read-only CI
observation:

```sh
npm run firstmate:delivery -- \
  create-pr TASK_ID PR_OPERATION_ID PR_APPROVAL_ID \
  main TITLE_FILE BODY_FILE [ADDITIONAL_REQUIRED_CHECK ...]
```

Required checks are always derived from current default-branch protection.
Additional names supplied on the command line are added to, never substituted
for, that policy. The PR observation is rejected if its stable head differs
from the exact approved delivery SHA.

An uncertain PR write is reconciled without a second POST:

```sh
npm run firstmate:delivery -- reconcile-pr TASK_ID PR_OPERATION_ID
```

CI is safe to observe again because it is read-only:

```sh
npm run firstmate:delivery -- ci TASK_ID PR_OPERATION_ID
```

Passing CI is evidence for a later human decision. It cannot mark the PR ready,
rerun a workflow, comment, update the branch, or release the worktree.

## Separately approve and merge

After a human marks the draft ready in GitHub and Firstmate records fresh passing
CI evidence, record the exact merge approval and execute it as separate commands:

```sh
SHIPMATES_HUMAN_ACTOR=YOUR_NAME npm run firstmate:delivery -- \
  approve-merge TASK_ID MERGE_APPROVAL_ID

npm run firstmate:delivery -- \
  merge TASK_ID MERGE_OPERATION_ID MERGE_APPROVAL_ID
```

An uncertain merge must be reconciled rather than repeated:

```sh
npm run firstmate:delivery -- \
  reconcile-merge TASK_ID MERGE_OPERATION_ID
```

See the [exact-head merge guide](github-merge.md) for compare-and-act
preconditions and the remaining post-merge boundary.
