import assert from "node:assert/strict";
import test from "node:test";

import { runFirstmateDeliveryCli } from "../src/cli/firstmate-delivery.js";

test("dispatches delivery status and exact push without reading a new task prompt", async () => {
  const calls = [];
  const workflow = {
    async status(input) {
      calls.push(["status", input]);
      return { stage: "awaiting_push_approval" };
    },
    async push(input) {
      calls.push(["push", input]);
      return { stage: "awaiting_draft_pr_approval" };
    },
  };
  const output = [];

  await runFirstmateDeliveryCli({
    args: ["status", "task-001"],
    workflow,
    write: (value) => output.push(value),
  });
  await runFirstmateDeliveryCli({
    args: ["push", "task-001", "push-operation-001", "push-approval-001"],
    workflow,
    write: (value) => output.push(value),
  });

  assert.deepEqual(calls, [
    ["status", { taskId: "task-001" }],
    ["push", {
      taskId: "task-001",
      operationId: "push-operation-001",
      approvalId: "push-approval-001",
    }],
  ]);
  assert.equal(JSON.parse(output[1]).stage, "awaiting_draft_pr_approval");
});

test("requires an explicit human identity for each approval command", async () => {
  await assert.rejects(
    runFirstmateDeliveryCli({
      args: ["approve-push", "task-001", "approval-001"],
      env: {},
      workflow: { approvePush() {} },
      write() {},
    }),
    /SHIPMATES_HUMAN_ACTOR/u,
  );
});

test("dispatches only the bound merge operation after separate approval", async () => {
  const calls = [];
  await runFirstmateDeliveryCli({
    args: ["merge", "task-001", "merge-operation-001", "merge-approval-001"],
    workflow: {
      async merge(input) {
        calls.push(input);
        return { stage: "landed" };
      },
    },
    write() {},
  });

  assert.deepEqual(calls, [{
    taskId: "task-001",
    operationId: "merge-operation-001",
    approvalId: "merge-approval-001",
  }]);
});

test("dispatches post-merge assurance and return reconciliation", async () => {
  const calls = [];
  const workflow = {
    async completePostMerge(input) {
      calls.push(["post-merge", input]);
      return { stage: "complete" };
    },
    async reconcileTreehouseReturn(input) {
      calls.push(["reconcile-return", input]);
      return { stage: "complete" };
    },
  };

  await runFirstmateDeliveryCli({
    args: ["post-merge", "task-001", "assurance-001"],
    workflow,
    write() {},
  });
  await runFirstmateDeliveryCli({
    args: ["reconcile-return", "task-001"],
    workflow,
    write() {},
  });

  assert.deepEqual(calls, [
    ["post-merge", { taskId: "task-001", operationId: "assurance-001" }],
    ["reconcile-return", { taskId: "task-001" }],
  ]);
});
