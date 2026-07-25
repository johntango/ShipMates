import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlPlaneRefusal,
  FIRSTMATE_COMMANDS,
  FirstmateControlPlane,
  selectFirstmateCommand,
} from "../src/control/firstmate-control-plane.js";

test("exposes the complete bounded lifecycle command vocabulary", () => {
  assert.deepEqual(FIRSTMATE_COMMANDS, [
    "project.create", "project.approve", "project.advance", "task.inspect",
    "task.reconcile", "validation.approve", "delivery.retry",
    "project.archive", "repository.purge",
  ]);
});

test("natural language selects a typed command but cannot select a transition", () => {
  assert.deepEqual(selectFirstmateCommand("please reconcile task-alpha"), {
    type: "task.reconcile", input: { taskId: "task-alpha" },
  });
  assert.equal(selectFirstmateCommand("move task-alpha directly to complete"), null);
});

test("validates stable inputs before invoking a deterministic handler", async () => {
  const calls = [];
  const plane = new FirstmateControlPlane({ handlers: {
    "task.reconcile": async (input) => { calls.push(input); return { decision: "no_action" }; },
  } });
  assert.deepEqual(await plane.execute({
    type: "task.reconcile", input: { taskId: "task-alpha" },
  }), { decision: "no_action" });
  assert.deepEqual(calls, [{ taskId: "task-alpha" }]);
  await assert.rejects(() => plane.execute({ type: "task.reconcile", input: {} }),
    (error) => error instanceof ControlPlaneRefusal && error.invariant === "required_command_input");
});

test("refusals name the invariant and next action", async () => {
  const plane = new FirstmateControlPlane({ handlers: {
    "project.approve": async () => {
      throw Object.assign(new Error("Plan is absent"), {
        invariant: "project_has_saved_plan", nextAction: "save and review a plan",
      });
    },
  } });
  await assert.rejects(() => plane.execute({
    type: "project.approve", input: { projectId: "project-one" },
  }), (error) => {
    assert.deepEqual(error.toJSON(), {
      accepted: false, command: "project.approve", invariant: "project_has_saved_plan",
      reason: "Plan is absent", nextAction: "save and review a plan",
    });
    return true;
  });
});

test("unknown commands and unconfigured handlers fail closed", async () => {
  const plane = new FirstmateControlPlane();
  await assert.rejects(() => plane.execute({ type: "task.force_complete", input: {} }),
    (error) => error.invariant === "known_command");
  await assert.rejects(() => plane.execute({
    type: "project.archive", input: { projectId: "project-one" },
  }), (error) => error.invariant === "handler_configured");
});
