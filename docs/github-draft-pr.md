# Approved draft pull requests and CI

ShipMates has one narrowly scoped GitHub write gateway: create a draft pull
request from an already pushed task branch. It cannot push, update a PR, mark a
PR ready, comment, review, rerun CI, merge, delete, or administer a repository.

## Approval boundary

Creation requires a separate durable human approval. The approval binds:

- task and repository;
- base and head branch;
- the full 40-character head SHA;
- SHA-256 digests of the PR title and body.

The task must still be in `validating` with a passing local-only validation for
the exact active Treehouse lease. Immediately before recording write intent,
ShipMates reads the remote head branch and requires the approved SHA. One
approval can be consumed by one creation operation.

The title and body are read from files by the CLI. The ledger stores their
digests, not the body. Credentials and raw GitHub failures are never stored.

## Crash safety

The ledger records `github.draft_pr.create.requested` before the POST and
`.completed` only after a second read confirms an open draft PR at the approved
repository, branches, SHA, and title digest. A completed operation ID is
idempotent.

Any error after the POST begins is treated as uncertain, not as proof of
failure. The request remains unresolved. Restart audits recommend
`reconcile_draft_pr_create`, and reconciliation lists GitHub pull requests and
requires exactly one matching draft. It never repeats the POST.

## CI observation

CI uses the existing read-only status workflow. It re-reads the PR, branch
protection, check runs, reviews, and workflow runs, then re-reads the PR head to
reject moved-head evidence. Required checks are evaluated only against that
exact SHA. This stage cannot rerun or modify a workflow.

## Commands

Prepare UTF-8 title and body files, then record the explicit approval:

```sh
SHIPMATES_HUMAN_ACTOR=YOUR_NAME npm run github:draft-pr -- approve \
  TASK_ID APPROVAL_ID owner/repo HEAD_BRANCH HEAD_SHA BASE_BRANCH \
  TITLE_FILE BODY_FILE
```

The following command is the external write and requires a separately confirmed
exact target before it is run:

```sh
npm run github:draft-pr -- create \
  TASK_ID OPERATION_ID APPROVAL_ID owner/repo HEAD_BRANCH HEAD_SHA BASE_BRANCH \
  TITLE_FILE BODY_FILE
```

Recovery and read-only CI observation:

```sh
npm run github:draft-pr -- reconcile TASK_ID OPERATION_ID
npm run github:draft-pr -- ci TASK_ID OPERATION_ID REQUIRED_CHECK ...
```

Routine tests inject GitHub clients and perform no network calls or writes.
