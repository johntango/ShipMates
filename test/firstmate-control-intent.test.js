import assert from "node:assert/strict";
import test from "node:test";

import { resolveFirstmateControlIntent } from "../src/cli/firstmate-control-intent.js";

const context = {
  projectId: "project-one", projectName: "TestA",
  planTaskId: "integration-validation", taskName: "Run final validation",
};
const projectStore = {
  async describeTask(taskId) { return taskId === "task-existing123" ? context : null; },
};

test("binds accepted warnings to an existing task before model classification", async () => {
  assert.deepEqual(await resolveFirstmateControlIntent({
    message: "Apply my accepted browser warning and complete task-existing123",
    projectStore,
  }), { action: "accept_demo_warning", taskId: "task-existing123", context });
});

test("binds recovery and status requests without creating implementation work", async () => {
  assert.equal((await resolveFirstmateControlIntent({
    message: "Recover task-existing123 without another retry", projectStore,
  })).action, "resume_existing");
  assert.equal((await resolveFirstmateControlIntent({
    message: "Show status for task-existing123", projectStore,
  })).action, "show_status");
});

test("binds deterministic task lifecycle controls to the existing attempt", async () => {
  assert.equal((await resolveFirstmateControlIntent({
    message: "Show task evidence task-existing123", projectStore,
  })).action, "show_evidence");
  assert.equal((await resolveFirstmateControlIntent({
    message: "Reconcile task task-existing123", projectStore,
  })).action, "reconcile_task");
  assert.equal((await resolveFirstmateControlIntent({
    message: "Retry blocked task task-existing123", projectStore,
  })).action, "retry_blocked");
  assert.deepEqual(await resolveFirstmateControlIntent({
    message: "Mark task-existing123 blocked because its runner vanished", projectStore,
  }), {
    action: "mark_blocked", taskId: "task-existing123", context,
    reason: "its runner vanished",
  });
});
