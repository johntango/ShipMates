import assert from "node:assert/strict";
import test from "node:test";

import {
  RECONCILIATION_DECISIONS,
  ReconciliationEngine,
} from "../src/reconciliation/reconciliation-engine.js";

const engine = new ReconciliationEngine();

test("exposes only the bounded reconciliation decision vocabulary", () => {
  assert.deepEqual(RECONCILIATION_DECISIONS, [
    "no_action", "record_observed_completion", "resume_existing_validation",
    "retry_delivery", "mark_worker_lost", "return_verified_lease",
    "request_human_approval", "require_manual_repair",
  ]);
});

test("uses the same deterministic plan for every caller surface", () => {
  const snapshot = base({
    state: "validating",
    validationRequests: [{ status: "requested" }],
  });
  const decisions = ["startup", "monitor", "dashboard", "command"].map((source) =>
    engine.plan({ snapshot, source }));
  assert.deepEqual(decisions.map(({ decision }) => decision), [
    "resume_existing_validation", "resume_existing_validation",
    "resume_existing_validation", "resume_existing_validation",
  ]);
  assert.deepEqual(decisions.map(({ evidence }) => evidence.source), [
    "startup", "monitor", "dashboard", "command",
  ]);
});

test("records ledger completion only when the project registry is stale", () => {
  const snapshot = base({ state: "complete" });
  assert.equal(engine.plan({ snapshot, projectTask: { status: "dispatched" } }).decision,
    "record_observed_completion");
  assert.equal(engine.plan({ snapshot, projectTask: { status: "completed" } }).decision,
    "no_action");
});

test("completes a planned read-only inspection without granting write authority", () => {
  const snapshot = base({
    state: "clarified",
    evidence: [{
      kind: "firstmate-local-execution",
      value: JSON.stringify({ status: "inspected", implementation: null }),
    }],
  });
  assert.equal(engine.plan({ snapshot, projectTask: { status: "dispatched" } }).decision,
    "record_observed_completion");
  assert.equal(engine.plan({ snapshot }).decision, "no_action");
});

test("does not treat intermediate workflow milestones as task completion", () => {
  const snapshots = [
    base({ state: "validating", validationRuns: [{ passed: true }] }),
    base({
      state: "validating",
      workers: [{
        id: "implementer", status: "reported",
        report: { status: "completed" }, verification: { noMutation: true },
      }],
    }),
    base({
      state: "awaiting_worker",
      workers: [{ id: "implementer", status: "reported", verification: { dirty: true } }],
    }),
  ];
  assert.deepEqual(snapshots.map((snapshot) => engine.plan({
    snapshot, projectTask: { status: "dispatched" },
  }).decision), ["require_manual_repair", "require_manual_repair", "require_manual_repair"]);
});

test("never repeats an uncertain worker without a process observation", () => {
  const snapshot = base({
    state: "awaiting_worker",
    workers: [{ id: "implementer", status: "started" }],
  });
  assert.equal(engine.plan({ snapshot }).decision, "require_manual_repair");
  assert.equal(engine.plan({ snapshot, observations: { worker: { status: "running" } } }).decision,
    "no_action");
  assert.equal(engine.plan({ snapshot, observations: { worker: { status: "missing" } } }).decision,
    "mark_worker_lost");
});

test("retries existing delivery intent and returns only a verified lease", () => {
  const delivery = base({
    state: "validating",
    gitPushes: [{ operationId: "push-1", status: "requested" }],
  });
  assert.equal(engine.plan({ snapshot: delivery }).decision, "retry_delivery");
  assert.equal(engine.plan({ snapshot: base({
    state: "cleaning", worktree: { status: "return_requested" },
  }), observations: { worktree: { state: "available", leaseHolder: null } } }).decision,
  "return_verified_lease");
});

test("routes approval gates and unknown repairs explicitly", () => {
  const approval = base({
    state: "validating",
    validationRuns: [{ passed: false, gate: { step: "review", status: "awaiting_approval" } }],
  });
  assert.equal(engine.plan({ snapshot: approval }).decision, "request_human_approval");
  assert.equal(engine.plan({ snapshot: base({ state: "blocked" }) }).decision,
    "require_manual_repair");
});

function base(overrides = {}) {
  return {
    id: "task-one", state: "running", lastEventId: "event-7", eventsCount: 7,
    workers: [], validationRuns: [], validationRequests: [], worktree: null,
    ...overrides,
  };
}
