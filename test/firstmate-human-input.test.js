import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

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
