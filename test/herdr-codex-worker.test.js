import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { CodexWorkerRuntime } from "../src/adapters/codex-worker.js";
import {
  HerdrCodexWorkerProcessError,
  HerdrCodexWorkerRuntime,
  writePaneTerminalMarker,
} from "../src/adapters/herdr-codex-worker.js";

const execFileAsync = promisify(execFile);

test("runs a Codex worker in its assigned Herdr pane and loads durable artifacts", async (t) => {
  const directory = await temporaryDirectory(t);
  const eventsPath = path.join(directory, "codex-events.jsonl");
  const reports = [];
  const commands = [];
  const baseRuntime = {
    async run() { assert.fail("pane-bound work must not run in the parent process"); },
    async loadCompleted({ taskId, artifactDirectory }) {
      assert.equal(taskId, "task-001");
      assert.equal(artifactDirectory, directory);
      return {
        threadId: "thread-001",
        report: { status: "completed" },
        artifacts: { events: eventsPath },
      };
    },
  };
  const runtime = new HerdrCodexWorkerRuntime({
    runtime: baseRuntime,
    observer: { paneIdFor: () => "w1:p2" },
    workerScript: "/shipmates/worker.js",
    nodePath: "/path with spaces/node",
    pollMs: 1,
    client: {
      async run({ paneId, command }) {
        commands.push({ paneId, command });
        const job = JSON.parse(await readFile(path.join(directory, "firstmate-pane-job.json")));
        assert.equal(job.workerId, "scout-1");
        assert.equal(job.paneId, "w1:p2");
        assert.equal(job.sandbox, "read-only");
        await writeFile(eventsPath, `${JSON.stringify({ type: "thread.started" })}\n`);
        await writePaneTerminalMarker(directory, {
          schemaVersion: 1,
          taskId: "task-001",
          workerId: "scout-1",
          paneId: "w1:p2",
          status: "completed",
          errorName: null,
          completedAt: "2026-07-14T17:00:00.000Z",
        });
      },
    },
  });

  const result = await runtime.run(workerInput(directory, {
    onEvent: (event) => reports.push(event),
  }));

  assert.equal(result.threadId, "thread-001");
  assert.deepEqual(reports, [{ type: "thread.started" }]);
  assert.equal(commands[0].paneId, "w1:p2");
  assert.match(commands[0].command, /^'\/path with spaces\/node'/u);
  assert.match(commands[0].command, /'\/shipmates\/worker\.js'/u);
});

test("falls back to the local Codex runtime when no pane is assigned", async (t) => {
  const directory = await temporaryDirectory(t);
  let localInput;
  const expected = { threadId: "thread-local" };
  const runtime = new HerdrCodexWorkerRuntime({
    runtime: {
      async run(input) { localInput = input; return expected; },
      async loadCompleted() {},
    },
    observer: { paneIdFor: () => null },
    workerScript: "/worker.js",
    client: { async run() { assert.fail("no pane command should be launched"); } },
  });

  assert.equal(await runtime.run(workerInput(directory)), expected);
  assert.equal(localInput.workerId, "scout-1");
});

test("treats a pane worker failure marker as definitive", async (t) => {
  const directory = await temporaryDirectory(t);
  const runtime = new HerdrCodexWorkerRuntime({
    runtime: { async run() {}, async loadCompleted() {} },
    observer: { paneIdFor: () => "w1:p2" },
    workerScript: "/worker.js",
    pollMs: 1,
    client: {
      async run() {
        await writePaneTerminalMarker(directory, {
          schemaVersion: 1,
          taskId: "task-001",
          workerId: "scout-1",
          paneId: "w1:p2",
          status: "failed",
          errorName: "CodexWorkerError",
          errorMessage: "Worker report fields do not match the schema",
          completedAt: "2026-07-14T17:00:00.000Z",
        });
      },
    },
  });

  await assert.rejects(
    runtime.run(workerInput(directory)),
    (error) => error instanceof HerdrCodexWorkerProcessError &&
      error.definitive === true && /fields do not match/iu.test(error.message),
  );
});

test("pane worker entrypoint records real Codex artifacts and a terminal marker", async (t) => {
  const directory = await temporaryDirectory(t);
  const fakeCodex = path.join(directory, "fake-codex.cjs");
  const artifactDirectory = path.join(directory, "artifacts");
  const jobPath = path.join(directory, "job.json");
  await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const reportPath = args[args.indexOf("--output-last-message") + 1];
fs.writeFileSync(reportPath, JSON.stringify({
  taskId: "structure-design", status: "completed", summary: "Inspected repository",
  branch: "main", commit: null, files: [], tests: [], risks: []
}));
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-pane" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
`);
  await chmod(fakeCodex, 0o700);
  await writeFile(jobPath, JSON.stringify({
    schemaVersion: 1,
    taskId: "task-001",
    workerId: "scout-1",
    paneId: "w1:p2",
    workingDirectory: directory,
    prompt: "Inspect the repository",
    schemaPath: path.resolve("schemas/codex-worker-report.schema.json"),
    artifactDirectory,
    sandbox: "read-only",
  }));

  const workerScript = path.resolve("scripts/firstmate-pane-codex-worker.js");
  const { stdout } = await execFileAsync(process.execPath, [workerScript, jobPath], {
    cwd: path.resolve("."),
    env: { ...process.env, CODEX_BIN: fakeCodex, HERDR_PANE_ID: "w1:p2" },
  });

  assert.match(stdout, /Codex started/u);
  assert.match(stdout, /thread started/u);
  assert.match(stdout, /Codex completed/u);
  const marker = JSON.parse(
    await readFile(path.join(artifactDirectory, "firstmate-pane-terminal.json")),
  );
  assert.equal(marker.status, "completed");
  assert.equal(marker.threadId, "thread-pane");
  const completed = await new CodexWorkerRuntime().loadCompleted({
    taskId: "task-001",
    artifactDirectory,
  });
  assert.equal(completed.threadId, "thread-pane");
  assert.equal(completed.report.taskId, "task-001");
  await assert.rejects(readFile(jobPath), (error) => error.code === "ENOENT");
});

function workerInput(artifactDirectory, overrides = {}) {
  return {
    taskId: "task-001",
    workerId: "scout-1",
    workingDirectory: "/repo",
    prompt: "Inspect the repository",
    schemaPath: "/schema.json",
    artifactDirectory,
    sandbox: "read-only",
    ...overrides,
  };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "herdr-codex-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
