# Codex MCP specialist

ShipMates can now run its bounded read-only Codex scout through
`codex mcp-server`. Firstmate exposes bounded Agents SDK function tools for a
new scout and a crash-safe scout reply, rather than exposing the raw MCP tools
to the model or handing off the human conversation.

## Verified protocol

The installed `codex-cli 0.144.1` MCP server and current OpenAI documentation
both expose:

- `codex` to start a thread;
- `codex-reply` to continue a thread.

A live `tools/list` handshake confirmed these are the only two server tools.
The installed backward-compatible `codex-reply` JSON schema marks only `prompt`
as formally required because it still accepts deprecated `conversationId`.
ShipMates does not use that looseness: its adapter requires an explicit
`threadId` and rejects a reply that changes it.

## Authority boundary

`CodexMcpRuntime` starts a local stdio server and calls its tools directly. It
never attaches that server to the Firstmate agent. Every new scout call fixes:

```json
{
  "sandbox": "read-only",
  "approval-policy": "never",
  "cwd": "the exact durable leased worktree"
}
```

The adapter injects read-only developer instructions and the trusted local
worker-report JSON schema. Callers cannot supply sandbox, approval policy,
working directory, model, configuration overrides, or extra MCP fields.

The MCP child receives the existing Codex sign-in environment but not
`OPENAI_API_KEY`, `GH_TOKEN`, or `GITHUB_TOKEN`. It receives an empty dedicated
GitHub CLI config directory and noninteractive Git settings. This keeps Codex
subscription authentication separate from Firstmate's Platform API key and
prevents the scout from inheriting GitHub authority.

## Result and recovery

The adapter requires `structuredContent.threadId` and parses
`structuredContent.content` as strict JSON. Markdown fences, missing thread
identity, MCP error results, extra report fields, and changed tool contracts all
fail closed. The independent worker-report validator runs before the result is
accepted.

The validated start result is atomically stored as
`codex-mcp-result.json` under the worker artifact directory. Raw prompts, MCP
response bodies, credentials, and errors are not persisted. The existing scout
workflow records dispatch intent before the MCP call, records the thread and
report afterward, then independently re-inspects Git before accepting
`noMutation: true`.

Replies are stored atomically under `replies/REPLY_ID.json` with the task,
worker thread, active lease SHA, read-only sandbox, prompt digest, validated
report, and completion time. The ledger records
`worker.reply.requested`, `.completed`, or `.failed`. A completed reply ID is
idempotently reused. A requested reply with no terminal event cannot call
`codex-reply` again; `reconcileReply()` must load and validate its durable
artifact. Restart audits surface these as `reconcile_worker_replies`.

## Firstmate composition

`createCodexScoutTool()` wraps the workflow as one strict Agents SDK function
tool. Tool input contains only `taskId`, `workerId`, and `brief`. The underlying
workflow resolves the leased directory and fixed authority from durable state.
Firstmate keeps ownership of the conversation and has no handoff to Codex.

`createCodexScoutReplyTool()` exposes the continuation as a second bounded
function tool. Its only additional authority is an immutable `replyId` and
prompt for an already reported worker. It cannot select a thread, worktree,
sandbox, approval policy, or credential environment.

## Live exercise

Task `codex-mcp-scout-20260713` completed against
`johntango/Shipmates-Practice` at
`4894811cf35e6e7b6559d4d75f2da78d24791c92`:

- backend `codex-mcp`;
- worker `scout-mcp-001`;
- thread `019f5d07-561d-7f70-959e-161046e3f5cd`;
- four files inspected;
- five tests passed;
- exact SHA and clean worktree independently verified;
- no-mutation proof recorded and Treehouse lease returned;
- restart audit `restart-live-codex-mcp-001` recorded `safeToResume: true`.

The first Treehouse return attempt was interrupted by filesystem sandboxing
after durable return intent. ShipMates inspected Treehouse, Git worktree, SHA,
and cleanliness before completing the return with the required filesystem
authority, then reconciled the durable result. It did not blindly repeat the
operation.

## Commands

Run or reconcile an already prepared ledger task:

```sh
npm run codex:mcp-scout -- run TASK_ID WORKER_ID "bounded brief"
npm run codex:mcp-scout -- reconcile TASK_ID WORKER_ID
npm run codex:mcp-scout -- reply TASK_ID WORKER_ID REPLY_ID "bounded follow-up"
npm run codex:mcp-scout -- reconcile-reply TASK_ID WORKER_ID REPLY_ID
```

The run command requires a task in `running` state with an active, matching,
clean Treehouse lease.

Verification:

```sh
node --test test/codex-mcp.test.js test/codex-scout-tool.test.js
node --test
git diff --check
```
