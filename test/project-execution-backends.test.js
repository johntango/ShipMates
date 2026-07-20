import assert from "node:assert/strict";
import test from "node:test";

import {
  createFirstmateProjectExecutionBackends,
  ProjectExecutionBackendRouter,
} from "../src/workflows/project-execution-backends.js";

test("routes standard and persistent projects through one dispatch contract", async () => {
  const calls = [];
  const router = new ProjectExecutionBackendRouter({
    standard: async (input) => { calls.push(["standard", input]); return "standard-result"; },
    persistent: async (input) => { calls.push(["persistent", input]); return "persistent-result"; },
  });
  assert.equal(await router.dispatch({ project: { executionPolicy: null } }), "standard-result");
  assert.equal(await router.dispatch({
    project: { executionPolicy: { mode: "persistent_project" } },
  }), "persistent-result");
  assert.deepEqual(calls.map(([mode]) => mode), ["standard", "persistent"]);
});

test("standard backend launches the common worker contract", () => {
  const calls = [];
  const child = { stdin: { end: (value) => calls.push(["stdin", value]) } };
  const router = createFirstmateProjectExecutionBackends({
    spawnProcess: (...args) => { calls.push(["spawn", ...args]); return child; },
    processPath: "/node", firstmateScript: "/firstmate.js",
    persistentScript: "/persistent.js", stateRoot: "/state", workingDirectory: "/cwd",
    projectTaskRuntime: { dispatch() {} }, hasProjectPane: () => false,
    environment: {},
  });
  assert.equal(router.dispatch({
    project: {}, taskId: "task-one", requestId: "request-one",
    context: { repo: "owner/repo", baseSha: "abc", repoPath: "/repo" },
    instruction: "Build it", validationProfile: "fast", demoMode: true,
  }), child);
  assert.deepEqual(calls[0][2], ["/firstmate.js", "task-one", "request-one", "owner/repo", "abc"]);
  assert.equal(calls[0][3].env.SHIPMATES_DEMO_MODE, "1");
  assert.deepEqual(calls[1], ["stdin", "Build it\n"]);
});

test("persistent backend prefers the project pane and preserves the common input", async () => {
  const calls = [];
  const paneResult = { paneId: "%12" };
  const router = createFirstmateProjectExecutionBackends({
    spawnProcess: () => { throw new Error("fallback process must not launch"); },
    processPath: "/node", firstmateScript: "/firstmate.js",
    persistentScript: "/persistent.js", stateRoot: "/state", workingDirectory: "/cwd",
    projectTaskRuntime: {
      async dispatch(input) { calls.push(input); return paneResult; },
    },
    hasProjectPane: () => true,
    environment: {},
  });
  const input = {
    project: { id: "project-one", executionPolicy: { mode: "persistent_project" } },
    planTaskId: "build", taskId: "task-one", baseSha: "abc", instruction: "Build it",
  };
  assert.equal(await router.dispatch(input), paneResult);
  assert.deepEqual(calls, [{
    project: input.project, planTaskId: "build", taskId: "task-one",
    baseSha: "abc", instruction: "Build it",
  }]);
});

test("persistent backend falls back to the persistent worker process", () => {
  const calls = [];
  const child = { stdin: { end: (value) => calls.push(["stdin", value]) } };
  const router = createFirstmateProjectExecutionBackends({
    spawnProcess: (...args) => { calls.push(["spawn", ...args]); return child; },
    processPath: "/node", firstmateScript: "/firstmate.js",
    persistentScript: "/persistent.js", stateRoot: "/state", workingDirectory: "/cwd",
    projectTaskRuntime: { dispatch() {} }, hasProjectPane: () => false,
    environment: {},
  });
  const result = router.dispatch({
    project: { id: "project-one", executionPolicy: { mode: "persistent_project" } },
    planTaskId: "build", taskId: "task-one", baseSha: "abc", instruction: "Build it",
  });
  assert.equal(result, child);
  assert.deepEqual(calls[0][2], ["/persistent.js", "project-one", "build", "abc"]);
  assert.equal(calls[0][3].env.SHIPMATES_STATE_DIR, "/state");
  assert.deepEqual(calls[1], ["stdin", "Build it\n"]);
});
