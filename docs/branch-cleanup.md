# Human-approved exact remote branch cleanup

Remote task-branch deletion is the final delivery authority boundary. It is not
implied by merge, landed-work assurance, Treehouse return, or task completion.
Firstmate requires a fourth explicit human approval bound to the repository,
branch, and full published head SHA.

This implementation does not delete a live branch during routine tests or PR
publication.

## Preconditions

Approval and deletion both require durable proof that:

- the task is `complete`;
- merge-commit checks passed in the bound post-merge assurance event;
- the confirmed squash tree exactly matched the approved task-head tree;
- the Treehouse lease was returned and its result recorded;
- the branch and head match the completed exact-head push;
- the repository is active and the task branch is not its default branch;
- the remote task branch still points to the exact published SHA;
- no cleanup has already completed for the task.

The approval also binds the post-merge assurance event, exact-tree proof event,
and Treehouse return event. Later commands derive all targets from the ledger.

## Approval and deletion

```sh
SHIPMATES_HUMAN_ACTOR=YOUR_NAME npm run firstmate:delivery -- \
  approve-cleanup TASK_ID CLEANUP_APPROVAL_ID

npm run firstmate:delivery -- \
  cleanup-branch TASK_ID CLEANUP_OPERATION_ID CLEANUP_APPROVAL_ID
```

Firstmate records durable intent before mutation. The adapter then invokes an
equivalent of:

```sh
git push --force-with-lease=refs/heads/TASK_BRANCH:FULL_EXPECTED_SHA \
  origin :refs/heads/TASK_BRANCH
```

The full remote ref and expected SHA make deletion atomic with respect to branch
movement: the remote refuses the write if another commit reached the branch.
The adapter independently verifies the configured `origin` repository before
and after the write and records only normalized evidence plus a transport-output
digest.

## Recovery

Any transport error after deletion begins is uncertain. Never run
`cleanup-branch` again for that operation:

```sh
npm run firstmate:delivery -- \
  reconcile-cleanup TASK_ID CLEANUP_OPERATION_ID
```

Reconciliation is read-only:

- an absent exact ref records recovered completion;
- the original head still present records a failed operation and requires a new
  human approval before another attempt;
- a different remote head is a conflict requiring manual recovery.

Completed cleanup does not delete local files, change the default branch,
modify the merged PR, or broaden any worker capability.
