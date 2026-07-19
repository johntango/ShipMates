import assert from "node:assert/strict";
import test from "node:test";

import {
  describeCodexActivity,
  HerdrExecutionObserver,
  HerdrFirstmateSession,
} from "../src/adapters/herdr-execution.js";

test("names the interactive FirstMate pane while it is listening", async () => {
  const reports = [];
  const releases = [];
  const metadata = [];
  const renames = [];
  const session = new HerdrFirstmateSession({
    paneId: "w1:p1",
    sessionId: "firstmate-session-1",
    client: {
      async processInfo() {
        return {
          foregroundProcesses: [{ argv: ["node", "scripts/firstmate.js"] }],
        };
      },
      async reportAgent(value) { reports.push(value); },
      async reportMetadata(value) { metadata.push(value); },
      async rename(value) { renames.push(value); },
      async releaseAgent(value) { releases.push(value); },
    },
  });

  await session.start({ repoPath: "/repo" });
  await session.stop();
  await session.stop();

  assert.deepEqual(reports, [{
    paneId: "w1:p1",
    source: "shipmates:firstmate:interactive:w1:p1",
    agent: "ShipMates FirstMate",
    state: "working",
    message: "FirstMate is listening",
    customStatus: "listening",
    seq: 1,
    agentSessionId: "firstmate-session-1",
    agentSessionPath: "/repo",
  }]);
  assert.deepEqual(releases, [{
    paneId: "w1:p1",
    source: "herdr:codex",
    agent: "codex",
  }, {
    paneId: "w1:p1",
    source: "shipmates:firstmate:interactive:w1:p1",
    agent: "ShipMates FirstMate",
    seq: 2,
  }]);
  assert.deepEqual(metadata, [{
    paneId: "w1:p1",
    source: "shipmates:firstmate:interactive:w1:p1",
    appliesToSource: "herdr:codex",
    displayAgent: "ShipMates FirstMate",
    customStatus: "listening",
    stateLabels: { idle: "running" },
    seq: 1,
  }, {
    paneId: "w1:p1",
    source: "shipmates:firstmate:interactive:w1:p1",
    appliesToSource: "herdr:codex",
    clearDisplayAgent: true,
    clearCustomStatus: true,
    clearStateLabels: true,
    seq: 2,
  }]);
  assert.deepEqual(renames, [{
    paneId: "w1:p1",
    label: "ShipMates FirstMate",
  }, {
    paneId: "w1:p1",
    label: null,
  }]);
});

test("does not clear a native Codex session from a pane FirstMate does not own", async () => {
  const reports = [];
  const warnings = [];
  const session = new HerdrFirstmateSession({
    paneId: "w1:p1",
    sessionId: "firstmate-session-2",
    onWarning: (message) => warnings.push(message),
    client: {
      async processInfo() {
        return { foregroundProcesses: [{ argv: ["codex"] }] };
      },
      async releaseAgent() { throw new Error("must not release"); },
      async reportAgent(value) { reports.push(value); },
    },
  });

  await session.start({ repoPath: "/repo" });

  assert.equal(reports.length, 0);
  assert.deepEqual(warnings, ["Herdr FirstMate session visibility unavailable: Error"]);
});

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

test("finalizes Firstmate after worker-pane selection disables visibility", async () => {
  const reports = [];
  const warnings = [];
  const observer = new HerdrExecutionObserver({
    currentPaneId: "w1:p1",
    panePool: { async select() { throw new Error("bad task state"); } },
    client: {
      async reportAgent(value) { reports.push(value); },
      async releaseAgent() {},
    },
    onWarning: (message) => warnings.push(message),
  });

  await observer.firstmateStage({
    taskId: "task-001",
    repoPath: "/repo",
    message: "Classifying request",
    customStatus: "classifying",
  });
  await observer.begin({ taskId: "task-001", repoPath: "/repo" });
  await observer.end({ status: "inspected" });

  assert.deepEqual(warnings, ["Herdr visibility disabled: Error"]);
  assert.equal(reports.length, 2);
  assert.deepEqual(reports.at(-1), {
    paneId: "w1:p1",
    source: "shipmates:firstmate:task-001",
    agent: "ShipMates Firstmate",
    state: "working",
    message: "FirstMate is listening",
    customStatus: "listening",
    seq: 2,
    agentSessionId: "task-001",
    agentSessionPath: "/repo",
  });
});
