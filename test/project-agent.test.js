import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectAgentTools,
  ProjectAgentController,
} from "../src/agents/project-agent.js";

const project = { id: "project-1", name: "BallsA", executionPolicy: { worktreePath: "/worktree" } };
const task = { id: "interface", title: "Build interface" };

test("exposes only fixed bounded project lifecycle tools", async () => {
  const calls = [];
  const operations = fixtureOperations(calls);
  const tools = createProjectAgentTools({ project, task, operations });
  assert.deepEqual(tools.map(({ name }) => name), [
    "inspect_project_status", "dispatch_implementer", "reconcile_implementer",
    "run_milestone_validation", "request_human_attention",
  ]);
  assert.equal(await tools[0].needsApproval({ context: {} }, {}), false);
  await tools[1].invoke({ context: {} }, JSON.stringify({ instruction: "Build it" }));
  assert.deepEqual(calls, [["dispatch", "Build it"]]);
});

test("Project Agent chooses bounded tools and reports its lifecycle to Herdr", async () => {
  const calls = [];
  const stages = [];
  const controller = new ProjectAgentController({
    project, task, operations: fixtureOperations(calls),
    observer: { stage: async (_project, stage) => stages.push(stage) },
    runAgent: async (agent) => {
      await agent.tools[0].invoke({ context: {} }, "{}");
      await agent.tools[1].invoke({ context: {} }, JSON.stringify({ instruction: "Build it" }));
      return { finalOutput: { status: "completed", summary: "Interface completed" } };
    },
  });
  const result = await controller.execute("Build it");
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, [["inspect"], ["dispatch", "Build it"], ["inspect"]]);
  assert.equal(stages.at(-1).state, "idle");
  assert.equal(stages.some(({ status }) => status === "implementing"), true);
});

test("deterministically dispatches when the model claims completion without using tools", async () => {
  const calls = [];
  const operations = fixtureOperations(calls);
  operations.reconcileImplementer = async () => { calls.push(["reconcile"]); return { status: "not_found" }; };
  const controller = new ProjectAgentController({
    project, task, operations,
    runAgent: async () => ({ finalOutput: { status: "completed", summary: "Done" } }),
  });
  const result = await controller.execute("Build it safely");
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, [
    ["reconcile"], ["dispatch", "Build it safely"], ["inspect"],
  ]);
});

function fixtureOperations(calls) {
  return {
    inspect: async () => { calls.push(["inspect"]); return { status: "ready", terminalMilestone: false }; },
    dispatchImplementer: async (instruction) => { calls.push(["dispatch", instruction]); return { status: "completed" }; },
    reconcileImplementer: async () => { calls.push(["reconcile"]); return { status: "completed" }; },
    validateMilestone: async (intent) => { calls.push(["validate", intent]); return { passed: true }; },
    requestAttention: async (reason) => { calls.push(["attention", reason]); return { referred: true }; },
  };
}
