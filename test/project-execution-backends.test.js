import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendFirstmateDiagnostic,
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

test("routes read-only work through the standard backend for persistent projects", async () => {
  const calls = [];
  const router = new ProjectExecutionBackendRouter({
    standard: async () => { calls.push("standard"); },
    persistent: async () => { calls.push("persistent"); },
  });
  await router.dispatch({
    authorizedAuthority: "read_only",
    project: { executionPolicy: { mode: "persistent_project" } },
  });
  assert.deepEqual(calls, ["standard"]);
});

test("standard backend launches the common worker contract from a durable governed envelope", async () => {
  const calls = [];
  const child = { stdin: { end: (value) => calls.push(["stdin", value]) } };
  const router = createFirstmateProjectExecutionBackends({
    spawnProcess: (...args) => { calls.push(["spawn", ...args]); return child; },
    processPath: "/node", firstmateScript: "/firstmate.js",
    persistentScript: "/persistent.js", stateRoot: "/state", workingDirectory: "/cwd",
    projectTaskRuntime: { dispatch() {} }, hasProjectPane: () => false,
    environment: {},
    writeEnvelope: async (input) => { calls.push(["envelope", input]); return "/state/governed.json"; },
  });
  assert.equal(await router.dispatch({
    project: { id: "project-one" }, planTaskId: "build", taskId: "task-one", requestId: "request-one",
    context: { repo: "owner/repo", baseSha: "abc", repoPath: "/repo" },
    instruction: "Build it", validationProfile: "fast", demoMode: true,
    authorizedAuthority: "local_write",
  }), child);
  assert.equal(calls[0][0], "envelope");
  assert.deepEqual(calls[1][2], ["/firstmate.js", "task-one", "request-one", "owner/repo", "abc"]);
  assert.equal(calls[1][3].env.SHIPMATES_DEMO_MODE, "1");
  assert.equal(calls[1][3].env.SHIPMATES_AUTHORIZED_AUTHORITY, "local_write");
  assert.equal(calls[1][3].env.SHIPMATES_GOVERNED_EXECUTION, "/state/governed.json");
  assert.deepEqual(calls[2], ["stdin", "Build it\n"]);
});

test("standard backend refuses local writes without a governed plan binding before spawn", async () => {
  let spawned = false;
  const router = createFirstmateProjectExecutionBackends({
    spawnProcess: () => { spawned = true; },
    processPath: "/node", firstmateScript: "/firstmate.js",
    persistentScript: "/persistent.js", stateRoot: "/state", workingDirectory: "/cwd",
    projectTaskRuntime: { dispatch() {} }, hasProjectPane: () => false,
    environment: {},
  });
  await assert.rejects(router.dispatch({
    project: { id: "project-one" }, taskId: "task-one", requestId: "request-one",
    context: { repo: "owner/repo", baseSha: "abc", repoPath: "/repo" },
    instruction: "Build it", authorizedAuthority: "local_write",
  }), /requires a project and planned task/);
  assert.equal(spawned, false);
});

test("durable child diagnostics create their protected parent directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shipmates-child-diagnostic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "tasks", "task-one", "child.stderr.log");
  await appendFirstmateDiagnostic(target, "hidden stack\n");
  assert.equal(await readFile(target, "utf8"), "hidden stack\n");
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
