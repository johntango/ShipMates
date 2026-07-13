# Herdr read-only task status

Herdr status is a deterministic projection of the authoritative ShipMates task
snapshot. It is an operator view, not a state store, command bus, workflow
trigger, or approval surface.

## Boundary

`HerdrProjection` receives only a store with `getSnapshot()`. It has no append,
transition, approval, GitHub, Treehouse, Codex, or Herdr-pane reporting
capability. Destroying the output loses no task state because every view can be
rebuilt from `events.jsonl` through the normal task store.

The projection includes:

- task lifecycle and ledger watermark;
- Treehouse worktree status and exact head;
- worker backend, pane, status, thread, verification, and reply status;
- latest local validation;
- draft-PR creation and latest exact-head CI observation;
- merge and draft-PR approvals;
- latest restart audit and recommended recovery actions;
- two-scout synthesis identity, exact-head binding, outcome, and counts;
- deterministic attention items and summary counts.

Worker briefs, prompts, report prose, PR bodies, API keys, GitHub tokens, and raw
tool responses are excluded. The projection has no generated timestamp; its
watermark comes from the ledger, so unchanged task state produces unchanged
JSON.

If any event is appended after the latest restart audit, Herdr displays that
audit as `stale` and adds an attention item. A synthesis with outcome
`review_required` also becomes an attention item, while its report prose and
proposed-check text remain outside the projection.

## Commands

Human-readable status:

```sh
npm run herdr:status -- view TASK_ID
```

Machine-readable projection:

```sh
npm run herdr:status -- json TASK_ID
```

The terminal renderer replaces control and formatting characters in projected
strings. The JSON command uses normal JSON escaping.

## Verification

Tests prove that projection does not mutate its source object, that the
projector cannot access any store method except `getSnapshot()`, and that the
authoritative event log and replaceable snapshot remain byte-for-byte unchanged
after reading a real task.

The local completed MCP scout was also projected through the CLI. Its event-log
and snapshot SHA-256 hashes were identical before and after the view.

The live two-scout synthesis demonstrated the stale-audit indicator before a
fresh read-only audit restored current `safe` status.

This stage does not publish to an external Herdr pane. The existing user-edited
`agent.js` pane reporter remains untouched; connecting this projection to that
sink would be a separate, bounded status-publication stage.
