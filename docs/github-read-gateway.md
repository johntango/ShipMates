# Read-only GitHub gateway

ShipMates observes GitHub through `GitHubReadGateway`. The adapter exposes only
typed read methods:

- repository metadata;
- default-branch protection;
- issue metadata;
- pull-request metadata and paginated history;
- check runs for one immutable commit SHA;
- pull-request reviews;
- workflow runs for one immutable commit SHA.

The default client always invokes `gh api --method GET`. Callers cannot supply
an HTTP method, arbitrary endpoint, shell command, or natural-language prompt.
The gateway stores normalized fields and a source endpoint, not raw terminal
output or complete GitHub responses.

## Exact-head status workflow

`GitHubStatusWorkflow.inspectPullRequest` performs this sequence:

1. verify the task and requested repository match;
2. read the repository and pull request;
3. read branch protection, checks, reviews, and workflow runs;
4. bind check and workflow evidence to the PR's full 40-character head SHA;
5. re-read the pull request;
6. refuse the report if the head moved;
7. record one `github.status.recorded` event in the task ledger.

The report includes the actor, observation timestamps, source identifiers,
repository, PR number, base and head SHAs, normalized conclusions, and an
explicit missing/unsuccessful required-check summary. Duplicate check names are
ambiguous and fail closed.

## Commands

List historical pull requests without changing GitHub:

```sh
node scripts/github-read.js history johntango/Shipmates-Practice
```

Record exact-head PR evidence into an existing task:

```sh
node scripts/github-read.js status TASK_ID johntango/Shipmates-Practice 2 test
```

The executable needs a deliberately selected read identity available to `gh`.
An invalid or absent identity causes the operation to fail before ledger
evidence is written. Do not repair authentication by silently adopting an
ambient human credential.

## Failure coverage

The tests cover multi-page results, duplicate/ambiguous results, malformed JSON
shapes, mismatched response targets, changed PR heads, missing checks, duplicate
check names, evidence bound to the wrong SHA, and attempts to smuggle a mutating
prompt into a read call.
