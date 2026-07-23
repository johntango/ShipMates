import assert from "node:assert/strict";
import test from "node:test";

import {
  HerdrNoMistakesObserver,
  parseAxiRunId,
} from "../src/adapters/herdr-no-mistakes.js";

test("parses quoted and unquoted AXI run identifiers without retaining quotes", () => {
  assert.equal(parseAxiRunId('run:\n  id: "01KY806YY3XQSHGHMBZKCZXM62"\n'), "01KY806YY3XQSHGHMBZKCZXM62");
  assert.equal(parseAxiRunId("run:\n  id: run-local-1\n"), "run-local-1");
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
    command: "'/usr/bin/node' '/repo/scripts/no-mistakes-pane.js' '/opt/no-mistakes' '/state/runtime' '/repo/worktree'",
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
