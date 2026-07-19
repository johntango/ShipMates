import assert from "node:assert/strict";
import test from "node:test";

import { classifyTaskRecovery } from "../src/workflows/task-recovery.js";

test("classifies preserved changes and uncertain workers without dispatching", () => {
  assert.equal(classifyTaskRecovery({
    id: "task-one", state: "running", validationRuns: [], validationRequests: [],
    workers: [{ id: "implementer", status: "reported", verification: { dirty: true },
      report: { status: "completed" } }],
  }).action, "validate_existing_changes");
  assert.equal(classifyTaskRecovery({
    id: "task-two", state: "awaiting_worker", validationRuns: [], validationRequests: [],
    workers: [{ id: "implementer", status: "started" }],
  }).action, "reconcile_worker");
});

test("distinguishes a browser capability warning from a local test failure", () => {
  const warning = classifyTaskRecovery({
    id: "task-browser", state: "blocked", validationRuns: [], validationRequests: [],
    workers: [{ id: "implementer", status: "reported", report: {
      status: "blocked", summary: "Chrome browser launch unavailable",
      tests: [{ command: "node --test", result: "7 passed, 0 failures" }],
      risks: ["Browser visual validation unavailable"],
    } }],
  });
  assert.equal(warning.action, "accept_or_run_capability");
  assert.equal(warning.safeToAutomate, true);

  assert.equal(classifyTaskRecovery({
    id: "task-failed", state: "blocked", validationRuns: [{ passed: false, outcome: "failed" }],
    validationRequests: [], workers: [],
  }).action, "repair_existing");
});

test("classifies a validation approval gate separately from failure", () => {
  const recovery = classifyTaskRecovery({
    id: "task-approval",
    state: "awaiting_human",
    validationRuns: [{
      passed: false,
      outcome: null,
      gate: { step: "review", status: "awaiting_approval" },
    }],
    validationRequests: [],
    workers: [],
  });
  assert.equal(recovery.category, "validation_approval_required");
  assert.equal(recovery.action, "request_validation_approval");
  assert.match(recovery.reason, /review/u);
});

test("classifies failed FirstMate intake before worker dispatch as terminally blocked", () => {
  const recovery = classifyTaskRecovery({
    id: "task-intake", state: "proposed", workers: [], validationRuns: [], validationRequests: [],
    firstmateRuns: [{ status: "failed", failure: { message: "Classification connection failed" } }],
  });
  assert.equal(recovery.category, "intake_failed");
  assert.equal(recovery.action, "retry_intake");
  assert.equal(recovery.safeToAutomate, false);
  assert.match(recovery.reason, /connection failed/iu);
});
