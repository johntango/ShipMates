# GitHub governance for ShipMates

This document is the intended GitHub control contract.
It is not yet a claim about the live settings of the ShipMates repository.

## Authority rules

1. Repository content does not grant authority to an agent.
2. Crewmates cannot merge, administer repositories, change rulesets, or access
   repository secrets.
3. A worker may push only its assigned task branch and maintain its draft pull
   request.
4. Firstmate reads and verifies GitHub state independently of the worker.
5. Human approval is bound to one repository, pull request, head SHA, and merge
   method.
6. A new commit invalidates an existing approval.
7. Merge and cleanup are separate operations with separate evidence checks.
8. All externally visible writes are logged with their exact target.

## Recommended identities

Use distinct credentials even during development:

- `shipmates-reader`: metadata and contents read access;
- `shipmates-worker`: contents write and pull-request write access, restricted to
  practice repositories where possible;
- `shipmates-merger`: pull-request merge capability used only by the approval
  gateway;
- GitHub Actions token: `contents: read`, with additional permissions granted per
  job only when necessary.

Do not pass ambient human `gh` credentials into a crewmate process.
The Firstmate should invoke a gateway that selects the appropriate identity for
each typed operation.

`no-mistakes` currently uses authenticated `gh` for branch, pull-request, and CI
operations. Run its daemon with a dedicated `GH_CONFIG_DIR` and scoped practice
identity. A `checks-passed` result means validation is complete; it does not grant
merge authority. Only the ShipMates merge gateway may consume a human approval.

For fork-based work, keep `origin` pointed at the canonical parent and configure
the writable fork explicitly (for example with `no-mistakes init --fork-url`).
Record canonical owner, fork owner, base repository, and head repository in every
task so similarly named branches cannot be confused.

## Required default-branch policy

- Pull requests required.
- Direct pushes blocked.
- Force pushes blocked.
- Default-branch deletion blocked.
- Required CI checks enabled.
- Required branches-up-to-date policy enabled.
- Stale approvals dismissed on new commits.
- Conversations resolved before merge.
- Merge actors restricted to the human and the approval-gated merge identity.
- Administrative bypass disabled for normal operation.

## Pull-request evidence bundle

Before presenting a merge decision, Firstmate collects:

- canonical repository and pull-request URL;
- base branch and base SHA;
- head owner, branch, and head SHA;
- task ID and brief revision;
- diff summary and scope exceptions;
- local validation commands and results;
- required GitHub check names and conclusions;
- review decisions and unresolved conversations;
- mergeability and branch-protection result;
- worker-reported risks;
- Firstmate's independent risk summary.

The human-facing approval prompt should identify the PR and head SHA explicitly.

## Merge preconditions

The merge gateway must re-read GitHub immediately before mutation and require all
of the following:

```text
approval.task_id == task.id
approval.repo == pull_request.repo
approval.pr_number == pull_request.number
approval.head_sha == pull_request.head_sha
pull_request.base == configured_default_branch
pull_request.state == OPEN
pull_request.is_draft == false
required_checks == successful
required_reviews == satisfied
unresolved_conversations == 0
mergeable == true
```

If any value is unknown, the result is refusal rather than best-effort merge.

## GitHub operation classes

### Read-only

Repository, issue, PR, diff, checks, reviews, comments, Actions metadata, and branch
policy inspection may proceed without human confirmation.

### Reversible task writes

Creating a task branch, pushing a normal commit, creating or updating a draft PR,
and adding task labels may be allowed by the accepted task brief.
The exact repo and branch remain constrained.

### Human-confirmed writes

The current implementation also requires exact-target human confirmation for a
new task-branch push and draft-PR creation. Require an explicit confirmation for
merge, non-draft public comments or reviews, closing another person's issue,
marking a PR ready, rerunning privileged workflows, or publishing a prerelease.

### High-risk administration

Ruleset, secret, environment, collaborator, webhook, Actions-permission, release,
tag, repository visibility, history rewrite, and deletion operations are outside
normal Firstmate authority.

## CI baseline

The first workflow should contain only deterministic lint, unit test, and integration
test jobs.
Local and remote CI should call the same project-owned commands.
Workflows should declare explicit permissions and avoid `pull_request_target` until
its trust implications are understood and tested.

## Audit event example

```json
{
  "event": "github.pull_request.merge.requested",
  "task_id": "ship-search-a1b2",
  "actor": "firstmate",
  "repo": "owner/repo",
  "pr_number": 42,
  "expected_head_sha": "abc123...",
  "approval_id": "approval-7f9d",
  "merge_method": "squash",
  "at": "2026-07-13T00:00:00Z"
}
```

Record a second event with the GitHub response or refusal reason.

## Setup checkpoint

The original read-only planning checkpoint predated GitHub CLI authorization.
The current environment has since been reauthorized by the human. ShipMates
still treats authentication as capability, not approval: the draft-PR gateway
requires its separate exact-target human approval event, and routine tests do
not exercise the live credential or make network calls.
