import assert from "node:assert/strict";
import test from "node:test";

import { HerdrWorkflowRunObserver } from "../src/adapters/herdr-workflow-run.js";

test("opens a distinct best-effort Implementer watcher pane", async () => {
  const calls = [];
  const observer = new HerdrWorkflowRunObserver({
    client: {
      split: async (value) => { calls.push(["split", value]); return { paneId: "w1:p2" }; },
      reportAgent: async (value) => calls.push(["agent", value]),
      run: async (value) => calls.push(["run", value]),
    },
    currentPaneId: "w1:p1",
    watcherScript: "/repo/scripts/workflow-run-pane.js",
    nodePath: "/usr/bin/node",
  });

  assert.equal(await observer.started({
    runId: "private-run", repoPath: "/repo",
    operationDirectory: "/state/operation",
  }), "w1:p2");
  assert.deepEqual(calls[0], ["split", { paneId: "w1:p1", cwd: "/repo" }]);
  assert.equal(calls[1][1].agent, "ShipMates Implementer");
  assert.deepEqual(calls[2], ["run", {
    paneId: "w1:p2",
    command: "'/usr/bin/node' '/repo/scripts/workflow-run-pane.js' '/state/operation' 'w1:p2' 'shipmates:simple-implementer'",
  }]);
});

test("Herdr absence or failure never blocks Implementer execution", async () => {
  const warnings = [];
  const hidden = new HerdrWorkflowRunObserver({
    client: {}, currentPaneId: null, watcherScript: "/watcher.js",
  });
  assert.equal(await hidden.started({}), null);
  const failing = new HerdrWorkflowRunObserver({
    client: { split: async () => { throw new Error("offline"); } },
    currentPaneId: "w1:p1", watcherScript: "/watcher.js",
    onWarning: (message) => warnings.push(message),
  });
  assert.equal(await failing.started({ repoPath: "/repo" }), null);
  assert.deepEqual(warnings, ["Implementer Herdr visibility unavailable (Error)"]);
});
