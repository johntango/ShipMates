import assert from "node:assert/strict";
import test from "node:test";

import { projectOperationalState } from "../src/projections/operational-state.js";

test("derives operator state from authoritative evidence and live observations", () => {
  const snapshot = base({
    state: "blocked",
    workers: [{ id: "implementer", status: "reported", report: {
      status: "blocked", summary: "Dependency is unavailable",
    } }],
  });
  const projection = projectOperationalState({
    snapshot, observations: { worker: { status: "exited", pid: 42 } }, source: "dashboard",
  });
  assert.deepEqual(projection.authoritative, {
    taskId: "task-one", state: "blocked", eventsCount: 9,
    lastEventId: "event-9", lastEventAt: "2026-07-25T12:00:00Z",
  });
  assert.deepEqual(projection.blocker, { state: "blocked", reason: "Dependency is unavailable" });
  assert.equal(projection.observations.worker.status, "exited");
  assert.equal(projection.recovery.evidence.source, "dashboard");
});

test("shows the exact validated commit and delivery destination", () => {
  const projection = projectOperationalState({ snapshot: base({
    state: "complete",
    validationRuns: [{ passed: true, headSha: "validated-sha", outcome: "passed" }],
    evidence: [{ kind: "local-delivery", value: "validated-sha" }],
  }) });
  assert.deepEqual(projection.validation, {
    status: "passed", commit: "validated-sha", outcome: "passed",
  });
  assert.deepEqual(projection.delivery, {
    kind: "local", destination: "validated-sha", operationId: null,
  });
});

test("does not copy prompts, report prose, or unknown live observation fields", () => {
  const projection = projectOperationalState({
    snapshot: base({ prompt: "secret", workers: [] }),
    observations: { worker: { status: "running" }, prompt: "secret", token: "secret" },
  });
  assert.deepEqual(Object.keys(projection.observations), ["worker"]);
  assert.equal(JSON.stringify(projection).includes("secret"), false);
});

function base(overrides = {}) {
  return {
    id: "task-one", state: "running", eventsCount: 9, lastEventId: "event-9",
    lastEventAt: "2026-07-25T12:00:00Z", workers: [], validationRuns: [],
    validationRequests: [], evidence: [], githubMerges: [], worktree: null,
    ...overrides,
  };
}
