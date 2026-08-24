import assert from "node:assert/strict";
import test from "node:test";

import {
  branchCustody,
  NoMistakesController,
  NoMistakesControllerRefusal,
} from "../src/control/no-mistakes-controller.js";

test("hard containment refuses orchestration and branch actions", () => {
  const controller = new NoMistakesController({ env: { NO_MISTAKES_GATE: "1" } });
  for (const action of ["worker.start", "worker.manage", "fleet.mutate", "branch.edit", "branch.rebase", "branch.push"]) {
    assert.throws(() => controller.assertAllowed(action), (error) =>
      error instanceof NoMistakesControllerRefusal &&
      error.invariant === "no_mistakes_containment");
  }
  assert.doesNotThrow(() => controller.assertAllowed("task.inspect"));
});

test("gate environment marks child agents as contained without unattended approval", () => {
  const env = new NoMistakesController({ env: {} }).gateEnvironment({ KEEP: "yes" });
  assert.deepEqual(env, { KEEP: "yes", NO_MISTAKES_GATE: "1" });
  assert.equal(Object.values(env).includes("--yes"), false);
});

test("a durable AXI submission owns branch mutations until a terminal result", () => {
  const submitted = {
    validationRequests: [{ status: "requested", attemptId: "attempt-1" }],
    validationRuns: [],
  };
  assert.deepEqual(branchCustody(submitted), {
    owned: true, status: "submitted", attemptId: "attempt-1", runId: null,
  });
  assert.throws(
    () => new NoMistakesController({ env: {} }).assertAllowed("branch.push", { snapshot: submitted }),
    (error) => error.invariant === "no_mistakes_branch_custody",
  );

  const awaitingUser = {
    validationRequests: [{ status: "completed", attemptId: "attempt-1", runId: "run-1" }],
    validationRuns: [{ runId: "run-1", gate: { status: "awaiting_approval" } }],
  };
  assert.equal(branchCustody(awaitingUser).owned, true);

  const uncertain = {
    validationRequests: [{ status: "completed", attemptId: "attempt-1", runId: "run-1" }],
    validationRuns: [],
  };
  assert.deepEqual(branchCustody(uncertain), {
    owned: true, status: "recovery_required", attemptId: "attempt-1", runId: "run-1",
  });

  const terminal = {
    validationRequests: [{ status: "completed", attemptId: "attempt-1", runId: "run-1" }],
    validationRuns: [{ runId: "run-1", gate: null, outcome: "passed" }],
  };
  assert.equal(branchCustody(terminal).owned, false);
  assert.doesNotThrow(() =>
    new NoMistakesController({ env: {} }).assertAllowed("branch.push", { snapshot: terminal }));
});
