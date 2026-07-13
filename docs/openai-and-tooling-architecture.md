# OpenAI and reference-tool architecture

## Decision

ShipMates will use the OpenAI Agents SDK for the Firstmate and run Codex as a
coding specialist through `codex mcp-server`. Firstmate remains the manager and
sole conversational owner. Codex workers, worktree operations, validation,
GitHub operations, and review surfaces are typed tools beneath it.

This is manager-style orchestration, not handoff-style orchestration. A handoff
would transfer ownership of the conversation to a specialist, which violates the
rule that the human interacts only with Firstmate.

## Component ownership

| Component | Adopted role | Must not own |
| --- | --- | --- |
| OpenAI Agents SDK | Firstmate loop, tool composition, guardrails, approval interruption, sessions, tracing | GitHub authorization or landed-work proof |
| Codex MCP server | Scoped investigation and code-development threads | Human conversation, merge, or cleanup authority |
| `johntango/firstmate` | Reference for coordinator/worker boundaries and lifecycle ideas | Runtime dependency or source copied wholesale |
| `johntango/treehouse` | Reusable leased Git worktrees through a `WorktreeManager` adapter | Task state or decision that work is safe to discard |
| `johntango/no-mistakes` | Local review/test/lint gate plus draft PR and CI supervision | Human approval or final merge authority |
| `johntango/lavish-axi` | Optional local visual artifact and feedback surface | Task command bus, durable state, or implicit publishing |
| Herdr | Operator dashboard derived from the task ledger | Authoritative lifecycle state |
| ShipMates | Policy, task ledger, decomposition, approvals, reconciliation, GitHub merge gateway | Reimplementation of the three specialist tools |

## OpenAI integration pattern

The initial TypeScript stack is:

```text
@openai/agents + zod v4
  Firstmate Agent
    tools:
      create_task / read_task / append_evidence
      lease_worktree / inspect_worktree / request_return
      codex_scout / codex_ship / codex_reply
      run_no_mistakes
      read_github_state / request_draft_pr
      request_merge (approval required)
      publish_herdr_status
      open_review_artifact
```

Start `codex mcp-server` as a child process and expose only the necessary Codex
tools to Firstmate. Bind every call to a recorded task ID, repository, leased
working directory, sandbox mode, and approval policy. Continue a worker with
`codex-reply` rather than starting an unrelated thread.

Use custom function tools around sensitive operations. Agents SDK input/output
guardrails protect the workflow boundary, while tool guardrails can validate each
custom operation. They are not a replacement for OS sandboxing, GitHub rulesets,
or gateway authorization.

## Human approval and recovery

An Agents SDK tool can declare `needsApproval`, causing a run to pause with an
interruption. Store the serializable run state so Firstmate can resume after the
human decides or after a restart.

For merge, also create a durable ShipMates approval containing:

```json
{
  "task_id": "ship-search-a1b2",
  "repo": "owner/repo",
  "pr_number": 42,
  "head_sha": "abc123...",
  "merge_method": "squash",
  "decision": "approved",
  "decided_at": "..."
}
```

The merge gateway re-reads GitHub and compares this record immediately before
mutation. A changed head SHA invalidates approval. The SDK interruption answers
“may this tool continue?”; the gateway answers “is this exact GitHub mutation
still authorized and safe?” Both checks are required.

Tracing is useful for correlation and debugging. Store the trace ID in the task
ledger, configure sensitive-data handling deliberately, and keep the local event
ledger as the recoverable authority.

## Authentication and cost boundary

Codex and the Agents SDK have distinct authentication paths:

- Local Codex workers may use ChatGPT sign-in under an eligible Codex
  subscription, or API-key authentication.
- The Agents SDK calls the OpenAI API and ordinarily needs an OpenAI Platform
  project/API key with API billing. A ChatGPT or Codex subscription is not, by
  itself, API credit. An enterprise arrangement may provide a different approved
  path.

Before implementation, create a low-limit practice Platform project, select the
approved organization/project, keep its key out of repositories and worker
worktrees, and verify the account's actual entitlements. Firstmate holds the API
credential; Codex workers and third-party helper processes should not inherit it
unless their documented authentication path requires it.

## Reference baseline and update policy

The repositories inspected for this plan were:

| Fork | Inspected commit | Upstream lineage |
| --- | --- | --- |
| `johntango/firstmate` | `b708731dc7840c088bcd8c79991b7f052f9a0096` | `kunchenguid/firstmate` |
| `johntango/lavish-axi` | `ab31405882f950696a2ddc79deb90d4caada7543` | `kunchenguid/lavish-axi` |
| `johntango/treehouse` | `81cc00172b3615cde67ff6fb0f99679a1274210e` | `kunchenguid/treehouse` |
| `johntango/no-mistakes` | `78e4dcb234274199717acafa90abca5cf7013993` | `kunchenguid/no-mistakes` |

All four presented MIT licenses at inspection time. Before vendoring, copying
code, or installing a release, recheck the license and pin the exact release or
commit. Keep adapters narrow so each dependency can be upgraded or replaced
without changing ShipMates policy.

Track the upstream project and the `johntango` fork separately:

1. upstream supplies project evolution and security fixes;
2. the fork supplies any ShipMates-specific integration changes;
3. an update PR records old/new commits, release notes, adapter contract changes,
   migration steps, and regression results;
4. no dependency updates itself at runtime.

## End-to-end controlled path

```text
Human request
  -> Firstmate classifies and records task
  -> Treehouse supplies a durable leased worktree
  -> Codex scout or ship thread receives a bounded brief
  -> Firstmate independently inspects worker evidence
  -> no-mistakes runs review/test/lint and manages draft PR/CI
  -> Firstmate reads GitHub through its gateway
  -> human sees exact PR, head SHA, checks, and risk summary
  -> Agents SDK pauses the merge tool for approval
  -> ShipMates records approval and revalidates GitHub
  -> merge gateway lands the exact approved head
  -> ShipMates proves landing
  -> Treehouse may safely return the worktree
```

Herdr may display every transition and lavish-axi may enrich a human review, but
neither can authorize or advance the path.

## Primary OpenAI references

- [Codex SDK](https://developers.openai.com/codex/sdk)
- [Run Codex as an MCP server](https://learn.chatgpt.com/docs/mcp-server)
- [Agents SDK for TypeScript](https://openai.github.io/openai-agents-js/)
- [Agent orchestration](https://developers.openai.com/api/docs/guides/agents/orchestration)
- [Human-in-the-loop approvals](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)
- [Guardrails](https://openai.github.io/openai-agents-js/guides/guardrails/)
- [Tracing](https://openai.github.io/openai-agents-js/guides/tracing/)
- [Codex authentication](https://developers.openai.com/codex/auth)
