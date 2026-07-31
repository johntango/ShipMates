import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { NoMistakesGateError } from "../src/adapters/no-mistakes.js";
import { LocalValidationRecoveryRequiredError } from "../src/workflows/local-validation.js";

test("surfaces validation and push approval gates in the Firstmate terminal", async () => {
  const source = await readFile(path.resolve("scripts/firstmate.js"), "utf8");
  assert.match(source, /local validation awaits human approval at/u);
  assert.match(source, /approve validation for task/u);
  assert.match(source, /passed local validation and awaits explicit push approval/u);
  assert.match(source, /console\.error\(humanInputRequired/u);
});

test("approval command validates, delivers, reconciles, and advances dependent work", async () => {
  const { handleValidationApproval } = await import(
    "../src/cli/firstmate-validation-approval.js"
  );
  const calls = [];
  const project = {
    id: "project-1",
    repoPath: "/registered/project",
    executionPolicy: { autoAdvance: true },
  };
  const result = await handleValidationApproval(
    "approve validation for task TASK-123",
    {
      store: {
        rootDir: "/state",
        getSnapshot: async (taskId) => {
          calls.push(["snapshot", taskId]);
          return {
            validationRuns: [{
              command: { args: ["axi", "run", "--intent", "repair approval"] },
            }],
          };
        },
      },
      projectStore: {
        describeAttempt: async (taskId) => {
          calls.push(["attempt", taskId]);
          return { projectId: project.id };
        },
        get: async (projectId) => {
          calls.push(["project", projectId]);
          return project;
        },
      },
      orchestrator: {
        reconcileTask: async (taskId) => {
          calls.push(["reconcile", taskId]);
          return {
            context: {
              projectId: project.id,
              projectName: "Approval project",
              taskName: "Repair approval",
            },
          };
        },
      },
      createGate: (options) => ({ options }),
      createValidationWorkflow: ({ gate, actor }) => ({
        approve: async (input) => calls.push(["approve", actor, input, gate.options]),
      }),
      createDeliveryWorkflow: ({ actor }) => ({
        deliver: async (input) => calls.push(["deliver", actor, input]),
      }),
      schedule: (callback) => callback(),
      advanceProject: async (projectId, options) => {
        calls.push(["advance", projectId, options]);
      },
    },
  );

  assert.equal(result.taskId, "task-123");
  assert.deepEqual(calls.map(([name]) => name), [
    "snapshot", "approve", "attempt", "project", "deliver", "reconcile",
    "project", "advance",
  ]);
  assert.deepEqual(calls[1][2], {
    taskId: "task-123", intent: "repair approval",
  });
  assert.equal(calls[4][2].destinationRepoPath, "/registered/project");
  assert.deepEqual(calls[7].slice(1), [
    "project-1", { reason: "validation approved and delivered" },
  ]);
});

test("retries delivery without rerunning validation after a terminal pass", async () => {
  const { handleValidationApproval } = await import(
    "../src/cli/firstmate-validation-approval.js"
  );
  const calls = [];
  const project = {
    id: "project-1",
    repoPath: "/registered/project",
    executionPolicy: { autoAdvance: false },
  };
  await handleValidationApproval(
    "approve validation for task task-123",
    {
      store: {
        rootDir: "/state",
        getSnapshot: async () => ({
          validationRuns: [{
            passed: true,
            command: { args: ["axi", "respond", "--action", "approve"] },
          }],
        }),
      },
      projectStore: {
        describeAttempt: async () => ({ projectId: project.id }),
        get: async () => project,
      },
      orchestrator: {
        reconcileTask: async () => ({
          context: { projectId: project.id, projectName: "TestA", taskName: "Tests" },
        }),
      },
      createValidationWorkflow: () => ({
        approve: async () => assert.fail("passing validation must not run again"),
      }),
      createDeliveryWorkflow: () => ({
        deliver: async (input) => calls.push(input),
      }),
      advanceProject: async () => assert.fail("auto advance is disabled"),
    },
  );

  assert.deepEqual(calls, [{
    taskId: "task-123", destinationRepoPath: "/registered/project",
  }]);
});

for (const [label, ApprovalError] of [
  ["gate error", NoMistakesGateError],
  ["recovery-required error", LocalValidationRecoveryRequiredError],
]) test(`moves a rejected validation ${label} out of stale human-input state`, async () => {
  const { handleValidationApproval } = await import(
    "../src/cli/firstmate-validation-approval.js"
  );
  const calls = [];
  const snapshots = [{
    state: "awaiting_human",
    validationRuns: [{
      command: { args: ["axi", "run", "--intent", "repair approval"] },
    }],
  }, { state: "awaiting_human" }];

  await assert.rejects(
    handleValidationApproval("approve validation for task task-123", {
      store: {
        rootDir: "/state",
        getSnapshot: async () => snapshots.shift(),
        transition: async (input) => calls.push(["transition", input]),
      },
      projectStore: {},
      orchestrator: {
        reconcileTask: async (taskId) => calls.push(["reconcile", taskId]),
      },
      createGate: () => ({}),
      createValidationWorkflow: () => ({
        approve: async () => {
          throw new ApprovalError("validator head changed");
        },
      }),
    }),
    /requires reconciliation; it is no longer waiting for human input/u,
  );

  assert.deepEqual(calls, [
    ["transition", {
      taskId: "task-123",
      from: "awaiting_human",
      to: "recovery_required",
      actor: "firstmate",
      reason: "Validation approval could not be reconciled safely: validator head changed",
      eventId: "task-123:validation:approval-recovery-required:v1",
    }],
    ["reconcile", "task-123"],
  ]);
});
