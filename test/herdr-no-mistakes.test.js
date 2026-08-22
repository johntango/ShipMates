import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HerdrNoMistakesObserver,
  matchesExpectedAxiRun,
  parseAxiRunId,
  projectNoMistakesHerdrStatus,
  retainedValidationSummary,
} from "../src/adapters/herdr-no-mistakes.js";

test("parses quoted and unquoted AXI run identifiers without retaining quotes", () => {
  assert.equal(parseAxiRunId('run:\n  id: "01KY806YY3XQSHGHMBZKCZXM62"\n'), "01KY806YY3XQSHGHMBZKCZXM62");
  assert.equal(parseAxiRunId("run:\n  id: run-local-1\n"), "run-local-1");
});

test("waits for the non-terminal AXI run matching the validated head", () => {
  const expected = "ba1381c7a18366d203b082d2806d13f32f15887c";
  assert.equal(matchesExpectedAxiRun(`run:
  id: old-run
  status: completed
  head: ba1381c7
outcome: passed
`, expected), false);
  assert.equal(matchesExpectedAxiRun(`run:
  id: wrong-run
  status: running
  head: 12345678
`, expected), false);
  assert.equal(matchesExpectedAxiRun(`run:
  id: current-run
  status: running
  head: ba1381c7
`, expected), true);
});

test("projects live no-mistakes stages and elapsed time into Herdr states", () => {
  const testing = projectNoMistakesHerdrStatus(`run:
  id: run-1
  status: running
  steps[3]{step,status,findings,duration_ms}:
    review,completed,0,1200
    test,running,0,0
    lint,pending,0,0
`, { elapsedMs: 72_400 });
  assert.deepEqual(testing, {
    state: "working",
    stage: "testing",
    customStatus: "testing · 1m 12s",
    message: "Validation testing",
    terminal: false,
  });

  const approval = projectNoMistakesHerdrStatus(`run:
  status: running
  awaiting_agent: parked 4s
  steps[1]{step,status,findings,duration_ms}:
    review,awaiting_approval,1,2000
`, { elapsedMs: 4_000 });
  assert.equal(approval.state, "blocked");
  assert.equal(approval.customStatus, "awaiting approval · 4s");
});

test("projects terminal no-mistakes outcomes into dashboard pass and failure states", () => {
  assert.deepEqual(projectNoMistakesHerdrStatus("outcome: passed\n", { elapsedMs: 8_000 }), {
    state: "idle",
    stage: "passed",
    customStatus: "passed · 8s",
    message: "Validation passed",
    terminal: true,
  });
  const failed = projectNoMistakesHerdrStatus("outcome: failed\n", { elapsedMs: 9_000 });
  assert.equal(failed.state, "blocked");
  assert.equal(failed.customStatus, "failed · 9s");
  assert.equal(retainedValidationSummary(projectNoMistakesHerdrStatus("outcome: passed\n")),
    "Validation passed. This pane is retained as read-only evidence.");
});

test("persists best-effort pane visibility without exposing it as authority", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-visibility-"));
  const operationId = "a".repeat(24);
  const calls = [];
  const observer = new HerdrNoMistakesObserver({
    client: {
      list: async () => [], split: async () => ({ paneId: "w1:p4" }),
      reportAgent: async () => {}, run: async (value) => calls.push(value),
    },
    currentPaneId: "w1:p1", watcherScript: "/watcher.js", displayTaskId: false,
    visibilityRoot: root,
  });
  assert.equal(await observer.started({
    taskId: `workflow-${operationId}`, binaryPath: "/validator", runtimeHome: "/state",
    worktreePath: "/worktree", expectedHeadSha: "a".repeat(40),
  }), "w1:p4");
  const target = path.join(root, operationId, "herdr-visibility.json");
  const receipt = JSON.parse(await readFile(target, "utf8"));
  assert.equal(receipt.available, true);
  assert.equal(receipt.state, "attach_started");
  assert.equal(receipt.summary, "Validation is visible in Herder.");
  assert.match(calls[0].command, new RegExp(target.replaceAll("/", "\\/"), "u"));
});

test("records unavailable visibility but never turns it into a validation failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-unavailable-"));
  const operationId = "b".repeat(24);
  const observer = new HerdrNoMistakesObserver({
    client: { list: async () => { throw new Error("offline"); } },
    currentPaneId: "w1:p1", watcherScript: "/watcher.js",
    visibilityRoot: root, onWarning: () => {},
  });
  assert.equal(await observer.started({
    taskId: `workflow-${operationId}`, worktreePath: "/worktree",
  }), null);
  const receipt = JSON.parse(await readFile(
    path.join(root, operationId, "herdr-visibility.json"), "utf8"));
  assert.equal(receipt.available, false);
  assert.equal(receipt.state, "attach_failed");
  assert.equal(receipt.summary, "Herder visibility unavailable; validation continues.");
});

test("opens a dedicated Herdr pane for the live no-mistakes TUI", async () => {
  const calls = [];
  const client = {
    list: async () => [],
    split: async (value) => { calls.push(["split", value]); return { paneId: "w1:p3" }; },
    reportAgent: async (value) => calls.push(["agent", value]),
    reportMetadata: async (value) => calls.push(["metadata", value]),
    run: async (value) => calls.push(["run", value]),
  };
  const observer = new HerdrNoMistakesObserver({
    client,
    currentPaneId: "w1:p1",
    watcherScript: "/repo/scripts/no-mistakes-pane.js",
    nodePath: "/usr/bin/node",
  });

  const paneId = await observer.started({
    taskId: "task-1",
    binaryPath: "/opt/no-mistakes",
    runtimeHome: "/state/runtime",
    worktreePath: "/repo/worktree",
    expectedHeadSha: "a".repeat(40),
  });

  assert.equal(paneId, "w1:p3");
  assert.deepEqual(calls[0], ["split", { paneId: "w1:p1", cwd: "/repo/worktree" }]);
  assert.match(calls.find(([kind]) => kind === "agent")[1].agent, /no-mistakes: task-1/u);
  assert.deepEqual(calls.at(-1), ["run", {
    paneId: "w1:p3",
    command: "'/usr/bin/node' '/repo/scripts/no-mistakes-pane.js' '/opt/no-mistakes' '/state/runtime' '/repo/worktree' 'w1:p3' 'shipmates:no-mistakes:task-1' 'ShipMates no-mistakes: task-1' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
  }]);
});

test("does nothing outside Herdr and treats visibility failures as non-fatal", async () => {
  const warnings = [];
  const hidden = new HerdrNoMistakesObserver({
    client: {}, watcherScript: "/repo/watcher.js", currentPaneId: null,
  });
  assert.equal(await hidden.started({}), null);

  const failing = new HerdrNoMistakesObserver({
    client: { list: async () => { throw new Error("offline"); } },
    watcherScript: "/repo/watcher.js",
    currentPaneId: "w1:p1",
    onWarning: (message) => warnings.push(message),
  });
  assert.equal(await failing.started({}), null);
  assert.deepEqual(warnings, ["no-mistakes Herdr visibility unavailable (Error)"]);
});

test("can hide internal task identity in the simple workflow pane label", async () => {
  const reports = [];
  const observer = new HerdrNoMistakesObserver({
    client: {
      list: async () => [], split: async () => ({ paneId: "w1:p4" }),
      reportAgent: async (value) => reports.push(value),
      run: async () => {},
    },
    currentPaneId: "w1:p1", watcherScript: "/watcher.js", displayTaskId: false,
  });
  await observer.started({
    taskId: "workflow-private-id", binaryPath: "/validator", runtimeHome: "/state",
    worktreePath: "/worktree", expectedHeadSha: "a".repeat(40),
  });
  assert.equal(reports[0].agent, "ShipMates no-mistakes");
});
