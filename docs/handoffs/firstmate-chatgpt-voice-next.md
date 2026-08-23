# First Mate ChatGPT and voice restart handoff

## Objective

Make First Mate available as a conversational front door inside ChatGPT/Codex,
including voice where the host supports it, without moving or duplicating the
durable ShipMates orchestration engine.

The target experience is:

```text
voice or text in ChatGPT/Codex
             |
             v
First Mate plugin / MCP adapter
             |
             v
local First Mate application API
             |
             v
WorkflowRun -> Implementer -> no-mistakes
```

The local First Mate core remains authoritative for scope, approval,
idempotency, workspace custody, exact-head validation, recovery, cleanup, and
delivery gates. ChatGPT, voice, the dashboard, and the terminal are replaceable
input/output adapters over that authority.

## Starting point

- Start from current `origin/main`. Inventory the checkout, branches, stashes,
  worktrees, saved state, and active processes before changing anything.
- PR #37 is merged on the last verified main baseline. It provides the
  append-only WorkflowRun controller, Initial Capabilities, Project Cycles,
  human-readable progress/results, dashboard history and artifacts, cleanup,
  and exact-head no-mistakes validation.
- `docs/handoffs/agent-skills-next.md` describes the separate Addy Osmani skill
  and Design Runtime work. Voice must not become a prerequisite for that work.
- Do not assume a First Mate process, validator, candidate, or saved session is
  active merely because historical evidence exists.

## Product decision

Build a ChatGPT/Codex-facing interface, not a second First Mate.

Keep:

- a local, headless First Mate core and WorkflowRun ledger;
- the existing dashboard and terminal as dependable fallbacks;
- one controller and one meaning for every high-level intent;
- explicit visible confirmation before consequential actions.

Do not give the conversational adapter raw shell, arbitrary Git, task IDs,
event-store writes, worktree mutation, cleanup/wipe, delivery, publication, or
destructive tools. It may submit typed high-level intents only.

OpenAI currently documents plugins as combinations of skills, MCP servers, and
optional UI, while Voice and Plugins are separately listed host capabilities.
Realtime audio also supports voice-agent tool use. Therefore direct plugin-tool
invocation from the exact ChatGPT voice surface must be treated as a product
compatibility question to test, not as an assumption.

Official references:

- https://developers.openai.com/plugins
- https://developers.openai.com/api/docs/guides/realtime
- https://learn.chatgpt.com/

## Typed interface

Begin with a versioned local application API. MCP tools and dashboard actions
must call the same methods.

Initial read-only intents:

- `firstmate_status`
- `firstmate_current_design`
- `firstmate_current_plan`
- `firstmate_artifacts`
- `firstmate_technical_evidence`

Later controlled intents:

- `firstmate_answer_design_question`
- `firstmate_propose_next_slice`
- `firstmate_approve_current_plan`
- `firstmate_approve_validation_decision`
- `firstmate_pause`
- `firstmate_cancel`

Every request should carry a schema version, channel (`terminal`, `dashboard`,
`plugin`, or `voice`), a client-generated idempotency key, and the expected
WorkflowRun revision when mutation is possible. Every response should carry a
plain-language projection, structured safe details, the current revision, and
whether confirmation is required. Internal IDs may exist in diagnostic details
but must not appear in ordinary speech or UI.

## Staged implementation

### Stage 0 — Contract and evaluation fixtures

Define the typed intent/result schemas and an adapter-neutral First Mate
application service. Add transcript fixtures for status, artifacts, design
questions, approval, pause, cancel, ambiguous speech, stale revisions, and
repeated delivery.

No runtime behavior changes in this stage.

Exit criteria:

- schemas reject unknown intents and expanded authority;
- projections contain no ordinary task/run IDs;
- repeated idempotency keys have deterministic results;
- existing terminal/dashboard behavior remains unchanged;
- fixtures can be executed without a model, microphone, network, or live worker.

### Stage 1 — Read-only local application API

Extract status, design, plan, artifact, and technical-evidence reads from the
current terminal/dashboard presentation boundary into the application service.
The service reads durable WorkflowRun evidence only and performs no `advance`,
launch, validation, cleanup, or delivery operation.

Exit criteria:

- terminal, dashboard, and application API return semantically identical
  current-run projections;
- completed artifacts include safe durable file links and created files;
- stale UI state cannot override ledger evidence;
- restart and concurrent reads append no events and launch nothing;
- old WorkflowRun ledgers remain readable.

### Stage 2 — Local MCP/plugin adapter, read-only

Wrap the Stage 1 service in a narrow local MCP server and package it as a First
Mate plugin with minimal metadata. Do not expose the database, filesystem,
shell, Git, controller, Implementer, or no-mistakes as tools.

Exit criteria:

- ChatGPT/Codex can request status, plan, design, artifacts, and evidence;
- malformed, oversized, prompt-injected, or unknown inputs fail closed;
- disconnect/reconnect changes no WorkflowRun state;
- plugin responses match the same golden projections as terminal/dashboard;
- the local service is not made publicly reachable merely for convenience.

### Stage 3 — Voice compatibility spike

Test whether the current ChatGPT/Codex voice surface can invoke the connected
read-only First Mate tools and speak their results. Keep this as a reversible
spike. If host voice cannot invoke plugin tools reliably, implement push-to-talk
and transcript confirmation in the localhost dashboard, backed by the same
application API. Do not build two intent systems.

Exit criteria:

- spoken status and artifact questions reach the correct completed/current run;
- the visible transcript can be reviewed or corrected;
- speech interruption, repetition, silence, and recognition failure mutate
  nothing;
- spoken output is concise, with technical details available on request;
- raw audio is not stored by ShipMates unless a later explicit policy allows it;
- one supported primary voice path and one text fallback are documented.

Stop after this stage if the host capability is unsuitable. The read-only MCP
adapter remains useful and no core redesign should be required.

### Stage 4 — Design interview through text and voice

Connect only the bounded Design Runtime interview actions: answer one Customer
Attribute/constraint question, review the current design brief, and request a
new proposal. Advisory model/skill output must still pass the existing typed
schema and be appended only by the First Mate controller.

Exit criteria:

- an interrupted interview resumes from durable unanswered questions;
- duplicate answers append no duplicate accepted evidence;
- the human sees the interpreted answer before it changes approved scope;
- voice and text produce the same CA/constraint/FR proposal given the same
  confirmed transcript;
- no interview action approves a plan or launches work.

### Stage 5 — Low-risk workflow controls

Add pause and cancel first. Then add plan approval and validation-decision
approval behind a two-part protocol: present the exact bounded scope/revision,
then accept an explicit confirmation referring to that current revision.

Approval spoken in an unrelated sentence, stale approval, low-confidence
transcription, or changed scope must not execute.

Exit criteria:

- exactly one confirmation produces exactly one durable approval event;
- replay, reconnect, and double speech cannot duplicate worker/validator launch;
- stale-revision confirmation is rejected with a plain refreshed summary;
- pause/cancel are idempotent and never imply deletion;
- publication, merge, wipe-clean, and destructive actions remain unavailable
  through ordinary voice/plugin tools.

### Stage 6 — Progress, notifications, and conversational continuity

Project evidence-derived progress through the plugin without polling the ledger
aggressively. Provide meaningful long-running updates such as “no-mistakes is
still testing” and one terminal notification. Preserve bounded conversation
context as a view over WorkflowRun evidence, not as lifecycle authority.

Exit criteria:

- progress stage changes are truthful and terminal outcomes are emitted once;
- a dropped client reconnects and receives current truth without replaying work;
- heartbeat/notification failures cannot terminate or block the workflow;
- a new conversation can answer “what happened?” from durable evidence;
- voice, dashboard, and terminal agree on phase, next action, files, and result.

### Stage 7 — Packaging and production decision

Only after the preceding stages pass, decide whether to distribute the plugin,
keep it private/local, or ship the dashboard voice fallback. Complete privacy,
authentication, permissions, logging, update, and rollback documentation.

Exit criteria:

- a reviewed threat model covers tool authority, local connectivity, transcript
  retention, prompt injection, replay, and user identity;
- plugin version and API schema compatibility are pinned and testable;
- uninstalling/disconnecting the plugin leaves First Mate core fully usable;
- terminal/dashboard fallback is documented and tested;
- no external publication occurs without its existing separate approval path.

## Test matrix required at every consequential stage

Run the relevant cases through terminal, dashboard, plugin text, and voice (when
available):

1. No run exists.
2. Planning and awaiting approval.
3. Implementer working.
4. no-mistakes validating for several minutes.
5. Validation decision required.
6. Passed with files and a candidate page.
7. Blocked safely with a concrete next action.
8. A newer blocked run exists after an older completed run.
9. Process termination at every durable boundary.
10. Duplicate, delayed, reordered, and stale client messages.
11. Ambiguous/incorrect voice transcript.
12. Attempted publication, wipe, arbitrary shell, or authority escalation.

For all cases assert:

- WorkflowRun remains the sole lifecycle authority;
- no duplicate worker or validator is launched;
- exact-head validation and workspace custody are unchanged;
- ordinary responses contain no internal IDs or expired localhost URLs;
- adapter failure does not corrupt or block the core workflow;
- consequential actions require the same or stronger approval as today.

## Recommended first development slice

Implement Stages 0 and 1 only: the versioned application-service contract plus
read-only status/design/plan/artifact/evidence methods, with golden parity tests
against current terminal and dashboard projections.

Do not start with audio, Realtime, plugin publication, or approval tools. This
slice proves that every future interface can share one truthful First Mate
boundary before any host-specific behavior is introduced.

## Non-goals for the first release

- Replacing WorkflowRun, Treehouse, Implementer, or no-mistakes.
- Giving ChatGPT direct filesystem, shell, Git, cleanup, or publication access.
- Making voice mandatory.
- Persisting raw audio in ShipMates.
- Automatically approving plans or validation concerns.
- Starting the next Project Cycle automatically.
- Combining this work with the Addy Osmani skill import or DesignPack rollout.

## Restart instructions

1. Fetch and inspect current `origin/main`; do not assume this handoff branch is
   current application code.
2. Read this file and `docs/handoffs/agent-skills-next.md`.
3. Inventory active First Mate processes, saved-state roots, worktrees, leases,
   branches, and stashes before mutation.
4. Create a fresh feature branch from current main.
5. Implement Stage 0 and Stage 1 behind a compatibility-preserving boundary.
6. Run focused projection/dashboard/WorkflowRun tests and the repository suite;
   distinguish established environmental failures from candidate regressions.
7. Stop at the stage exit gate and report evidence. Do not push or open a PR
   without explicit authorization.
