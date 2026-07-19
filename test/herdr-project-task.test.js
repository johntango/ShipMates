import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HerdrProjectTaskRuntime } from "../src/adapters/herdr-project-task.js";

test("runs a persistent Project Agent job in its assigned Herdr pane", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shipmates-project-pane-"));
  const commands = [];
  const project = { id: "project-a", name: "BallsA" };
  const runtime = new HerdrProjectTaskRuntime({
    client: { run: async (input) => commands.push(input) },
    observer: { paneIdFor: () => "pane-a", ensure: async () => assert.fail("pane already assigned") },
    workerScript: "/repo/scripts/project-agent-pane-worker.js",
    stateRoot: root,
    pollMs: 1,
  });
  const handle = await runtime.dispatch({
    project, planTaskId: "physics", taskId: "task-123", baseSha: "abc123",
    instruction: "Implement physics",
  });
  assert.equal(handle.paneId, "pane-a");
  assert.equal(commands[0].paneId, "pane-a");
  assert.match(commands[0].command, /project-agent-pane-worker\.js/u);
  const job = JSON.parse(await readFile(path.join(root, "project-agent-jobs/project-a/physics/job.json"), "utf8"));
  assert.equal(job.instruction, "Implement physics");
  const exited = new Promise((resolve) => handle.once("exit", (...args) => resolve(args)));
  await writeFile(job.terminalPath, `${JSON.stringify({
    schemaVersion: 1, projectId: "project-a", planTaskId: "physics",
    taskId: "task-123", exitCode: 0, signal: null, completedAt: new Date().toISOString(),
  })}\n`);
  assert.deepEqual(await exited, [0, null]);
});
