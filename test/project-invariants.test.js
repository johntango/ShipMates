import assert from "node:assert/strict";
import test from "node:test";

import { assertProjectInvariants, inspectProjectInvariants } from "../src/projects/project-invariants.js";

test("detects duplicate active attempts, missing blockers, and cross-task attachment", () => {
  const issues = inspectProjectInvariants({ tasks: [
    { id: "one", status: "blocked", blockingReason: null, taskId: "task-a", dependsOn: [], attempts: [
      { taskId: "task-a", status: "dispatched" }, { taskId: "task-b", status: "claimed" },
    ] },
    { id: "two", status: "planned", taskId: null, dependsOn: ["missing"], attempts: [
      { taskId: "task-a", status: "superseded" },
    ] },
  ] });
  assert.deepEqual(new Set(issues.map(({ code }) => code)), new Set([
    "multiple_active_attempts", "missing_blocking_reason",
    "attempt_attached_twice", "missing_dependency",
  ]));
});

test("accepts one current attempt and valid dependencies", () => {
  const project = { tasks: [
    { id: "one", status: "completed", taskId: "task-a", dependsOn: [], attempts: [
      { taskId: "task-a", status: "completed" },
    ] },
    { id: "two", status: "dispatched", taskId: "task-b", dependsOn: ["one"], attempts: [
      { taskId: "task-b", status: "dispatched" },
    ] },
  ] };
  assert.equal(assertProjectInvariants(project), project);
});
