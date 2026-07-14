# Human-approved exact-head branch push

ShipMates can publish one validated task commit to one new remote task branch.
The implementation worker receives no Git or GitHub authority. Firstmate uses a
separate adapter only after a human approval binds the exact repository, branch,
and full commit SHA.

## Safety boundary

The push workflow requires all of the following:

- the task is still `validating` on an active Treehouse lease;
- the controlled commit and passing local validation match the leased head;
- GitHub identifies the approved active repository and a different default
  branch;
- local `HEAD`, branch, and cleanliness match the approval;
- `origin` identifies the approved GitHub repository;
- the remote task branch does not already exist.

The only transport command is equivalent to:

```text
git push --porcelain --no-verify origin FULL_SHA:refs/heads/TASK_BRANCH
```

Force push, deletion, default-branch push, branch update, implicit `HEAD`, hooks,
and refspec broadening are outside this capability.

## Durable protocol and recovery

`git.push.approved` records the human's exact target. Before invoking Git,
`git.push.requested` consumes that approval and records a collision-resistant
attempt. Success requires both Git inspection and an independent GitHub branch
read proving the same full SHA before `git.push.completed` is accepted.

An error after transport begins is uncertain. Firstmate never automatically
repeats the push. Reconciliation performs only remote reads:

- exact remote SHA: record recovered completion;
- absent branch: record terminal failure and require a new human approval;
- any other SHA or ambiguous result: stop for manual recovery.

## Commands

Record the exact human approval:

```sh
SHIPMATES_HUMAN_ACTOR=YOUR_NAME npm run firstmate:push -- approve \
  TASK_ID APPROVAL_ID owner/repo TASK_BRANCH FULL_HEAD_SHA
```

Perform the one approved external write:

```sh
npm run firstmate:push -- push \
  TASK_ID OPERATION_ID APPROVAL_ID owner/repo TASK_BRANCH FULL_HEAD_SHA
```

After an interrupted or uncertain operation, use read-only reconciliation:

```sh
npm run firstmate:push -- reconcile TASK_ID OPERATION_ID
```

A completed exact push is a prerequisite for the separately approved
[draft-pull-request workflow](github-draft-pr.md). It does not approve PR
creation, CI mutation, merge, or cleanup.
