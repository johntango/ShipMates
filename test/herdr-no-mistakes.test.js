import assert from "node:assert/strict";
import test from "node:test";

import {
  HerdrNoMistakesObserver,
  parseAxiRunId,
  projectNoMistakesHerdrStatus,
} from "../src/adapters/herdr-no-mistakes.js";

test("parses quoted and unquoted AXI run identifiers without retaining quotes", () => {
  assert.equal(parseAxiRunId('run:\n  id: "01KY806YY3XQSHGHMBZKCZXM62"\n'), "01KY806YY3XQSHGHMBZKCZXM62");
  assert.equal(parseAxiRunId("run:\n  id: run-local-1\n"), "run-local-1");
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
  });

  assert.equal(paneId, "w1:p3");
  assert.deepEqual(calls[0], ["split", { paneId: "w1:p1", cwd: "/repo/worktree" }]);
  assert.match(calls.find(([kind]) => kind === "agent")[1].agent, /no-mistakes: task-1/u);
  assert.deepEqual(calls.at(-1), ["run", {
    paneId: "w1:p3",
    command: "'/usr/bin/node' '/repo/scripts/no-mistakes-pane.js' '/opt/no-mistakes' '/state/runtime' '/repo/worktree' 'w1:p3' 'shipmates:no-mistakes:task-1' 'ShipMates no-mistakes: task-1'",
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
