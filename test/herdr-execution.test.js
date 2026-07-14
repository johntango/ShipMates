import assert from "node:assert/strict";
import test from "node:test";

import {
  describeCodexActivity,
  HerdrExecutionObserver,
} from "../src/adapters/herdr-execution.js";

test("reports scout, tool, implementer, and Firstmate lifecycle to distinct panes", async () => {
  const reports = [];
  const releases = [];
  const observer = new HerdrExecutionObserver({
    currentPaneId: "w1:p1",
    panePool: {
      async select() {
        return [{ paneId: "w1:p2" }, { paneId: "w1:p3" }];
      },
    },
    client: {
      async reportAgent(value) { reports.push(value); },
      async releaseAgent(value) { releases.push(value); },
    },
  });

  await observer.firstmateStage({
    taskId: "task-001",
    repoPath: "/repo",
    message: "Classifying request",
    customStatus: "classifying",
  });
  await observer.begin({ taskId: "task-001", repoPath: "/repo" });
  await observer.workerStarted({ workerId: "scout-1", sandbox: "read-only" });
  await observer.workerEvent({
    workerId: "scout-1",
    event: {
      type: "item.started",
      item: { type: "command_execution", command: "SECRET COMMAND" },
    },
  });
  await observer.workerFinished({ workerId: "scout-1", report: { status: "completed" } });
  await observer.prepareImplementer();
  await observer.workerStarted({ workerId: "implementer", sandbox: "workspace-write" });
  await observer.workerEvent({
    workerId: "implementer",
    event: { type: "item.completed", item: { type: "file_change", status: "completed" } },
  });
  await observer.end({ status: "completed" });

  assert.equal(reports[0].paneId, "w1:p1");
  assert.equal(reports.some(({ paneId, agent }) =>
    paneId === "w1:p2" && agent === "ShipMates scout-1"), true);
  assert.equal(reports.some(({ paneId, agent }) =>
    paneId === "w1:p2" && agent === "ShipMates implementer"), true);
  assert.equal(reports.some(({ message }) => message === "tool shell started"), true);
  assert.equal(reports.some(({ message }) => message === "tool file-edit completed"), true);
  assert.doesNotMatch(JSON.stringify(reports), /SECRET COMMAND/u);
  assert.equal(releases.some(({ agent }) => agent === "ShipMates scout-1"), true);
  assert.equal(releases.some(({ agent }) => agent === "ShipMates implementer"), true);
});

test("sanitizes supported tool and skill events without exposing arguments", () => {
  assert.deepEqual(describeCodexActivity({
    type: "item.started",
    item: { type: "mcp_tool_call", tool: "mcp__github__read", arguments: "SECRET" },
  }), {
    status: "tool:mcp",
    message: "tool mcp__github__read started",
  });
  assert.deepEqual(describeCodexActivity({
    type: "item.completed",
    item: { type: "skill_invocation", skill: "review-code", contents: "SECRET" },
  }), {
    status: "skill",
    message: "skill review-code completed",
  });
});

test("disables visibility without failing execution when Herdr is unavailable", async () => {
  const warnings = [];
  const observer = new HerdrExecutionObserver({
    currentPaneId: "w1:p1",
    panePool: { async select() { throw new Error("offline"); } },
    client: {},
    onWarning: (message) => warnings.push(message),
  });
  await observer.begin({ taskId: "task-001", repoPath: "/repo" });
  await observer.workerStarted({ workerId: "scout-1", sandbox: "read-only" });
  assert.deepEqual(warnings, ["Herdr visibility disabled: Error"]);
});
