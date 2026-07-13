import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HerdrPanePool,
  HerdrPaneWorkerProcessError,
  HerdrPaneWorkerLauncher,
  shellQuote,
} from "../src/adapters/herdr-pane.js";
import { TaskStore } from "../src/storage/task-store.js";
import {
  ParallelCodexScoutsRecoveryRequiredError,
  ParallelCodexScoutsWorkflow,
} from "../src/workflows/parallel-codex-scouts.js";

const taskId = "parallel-scouts-001";
const headSha = "a".repeat(40);
const worktreePath = "/tmp/treehouse/parallel/repo";
const scouts = [
  { workerId: "scout-left", brief: "Inspect exported functions" },
  { workerId: "scout-right", brief: "Inspect the test coverage" },
];

test("runs exactly two scouts concurrently in distinct verified panes", async (t) => {
  const store = await runningLeasedTask(t);
  const launches = [];
  const releases = [];
  let active = 0;
  let maximumActive = 0;
  const workflow = workflowFor({
    store,
    launcher: {
      async run(input) {
        launches.push(input);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
      },
      async release(input) {
        releases.push(input);
      },
    },
  });

  const snapshot = await workflow.run({ taskId, scouts });

  assert.equal(maximumActive, 2);
  assert.equal(snapshot.state, "running");
  assert.deepEqual(snapshot.workers.map(({ status }) => status), ["reported", "reported"]);
  assert.deepEqual(snapshot.workers.map(({ paneId }) => paneId), ["w1:p2", "w1:p3"]);
  assert.equal(snapshot.workers.every(({ verification }) =>
    verification.noMutation === true && verification.paneId), true);
  assert.deepEqual(launches.map(({ paneId }) => paneId), ["w1:p2", "w1:p3"]);
  assert.deepEqual(releases.map(({ paneId }) => paneId), ["w1:p2", "w1:p3"]);
});

test("restart records one completed scout and preserves one uncertain pane", async (t) => {
  const store = await runningLeasedTask(t);
  for (const [index, scout] of scouts.entries()) {
    await store.requestWorkerDispatch({
      taskId,
      actor: "firstmate",
      workerId: scout.workerId,
      backend: "codex-mcp",
      mode: "scout",
      worktreePath,
      sandbox: "read-only",
      brief: scout.brief,
      briefSha256: "b".repeat(64),
      paneId: `w1:p${index + 2}`,
      eventId: `${scout.workerId}-dispatch`,
    });
  }
  await store.transition({
    taskId,
    from: "running",
    to: "awaiting_worker",
    actor: "firstmate",
    eventId: "pair-awaiting",
  });
  const releases = [];
  const workflow = workflowFor({
    store,
    loadCompleted(workerId) {
      if (workerId === "scout-right") throw new Error("artifact missing");
      return completed(workerId);
    },
    launcher: {
      async run() {
        throw new Error("reconcile must not relaunch");
      },
      async release(input) {
        releases.push(input);
      },
    },
  });

  await assert.rejects(
    workflow.reconcile({
      taskId,
      workerIds: scouts.map(({ workerId }) => workerId),
    }),
    ParallelCodexScoutsRecoveryRequiredError,
  );
  const snapshot = await store.getSnapshot(taskId);
  assert.equal(snapshot.state, "awaiting_worker");
  assert.equal(snapshot.workers[0].status, "reported");
  assert.equal(snapshot.workers[1].status, "dispatch_requested");
  assert.deepEqual(releases.map(({ workerId }) => workerId), ["scout-left"]);
});

test("pane pool reuses only idle unbound shells and creates missing capacity", async () => {
  const splits = [];
  const client = {
    async list() {
      return [
        pane("w1:p1", { agent: "firstmate" }),
        pane("w1:p2"),
        pane("w1:p3"),
        pane("w1:p4", { agent: "old-agent" }),
      ];
    },
    async processInfo(paneId) {
      if (paneId === "w1:p3") return processInfo(paneId, "gh", 300, 200);
      return processInfo(paneId, "zsh", 200, 200);
    },
    async split(input) {
      splits.push(input);
      return { paneId: `w1:p${splits.length + 4}` };
    },
  };
  const store = {
    async listTaskIds() {
      return ["other-task"];
    },
    async getSnapshot() {
      return {
        workers: [{ paneId: "w1:p2", status: "started" }],
      };
    },
  };
  const pool = new HerdrPanePool({ client, store, currentPaneId: "w1:p1" });

  const selected = await pool.select({ count: 2, cwd: "/repo" });

  assert.deepEqual(selected.map(({ paneId }) => paneId), ["w1:p5", "w1:p6"]);
  assert.equal(splits.length, 2);
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
});

test("pane launcher reports identity, waits for a terminal marker, and releases", async (t) => {
  const calls = [];
  const client = {
    async reportAgent(input) {
      calls.push({ operation: "report", input });
    },
    async run(input) {
      calls.push({ operation: "run", input });
    },
    async releaseAgent(input) {
      calls.push({ operation: "release", input });
    },
  };
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "pane-launcher-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const markerDirectory = path.join(
    stateDirectory,
    "tasks",
    taskId,
    "workers",
    "scout-left",
  );
  await mkdir(markerDirectory, { recursive: true });
  await writeFile(path.join(markerDirectory, "pane-terminal.json"), JSON.stringify({
    schemaVersion: 1,
    taskId,
    workerId: "scout-left",
    paneId: "w1:p2",
    status: "completed",
    errorName: null,
    completedAt: "2026-07-13T23:30:00.000Z",
  }));
  const launcher = new HerdrPaneWorkerLauncher({
    client,
    nodePath: "/path/with space/node",
    workerScript: "/shipmates/worker's-script.js",
    stateDirectory,
  });

  await launcher.run({
    taskId,
    workerId: "scout-left",
    paneId: "w1:p2",
    worktreePath,
  });
  await launcher.release({ taskId, workerId: "scout-left", paneId: "w1:p2" });

  assert.deepEqual(calls.map(({ operation }) => operation), [
    "report", "run", "report", "release",
  ]);
  assert.equal(calls[0].input.state, "working");
  assert.equal(calls[2].input.state, "idle");
  assert.equal(calls[3].input.source, `shipmates:worker:${taskId}:scout-left`);
  assert.match(calls[1].input.command, /^'\/path\/with space\/node'/u);
  assert.match(calls[1].input.command, /worker'"'"'s-script/u);
});

test("pane launcher treats an atomic failed marker as a definitive failure", async (t) => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "pane-failure-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const markerDirectory = path.join(
    stateDirectory,
    "tasks",
    taskId,
    "workers",
    "scout-left",
  );
  await mkdir(markerDirectory, { recursive: true });
  await writeFile(path.join(markerDirectory, "pane-terminal.json"), JSON.stringify({
    schemaVersion: 1,
    taskId,
    workerId: "scout-left",
    paneId: "w1:p2",
    status: "failed",
    errorName: "PaneWorkerAuthorityError",
    completedAt: "2026-07-13T23:30:00.000Z",
  }));
  const launcher = new HerdrPaneWorkerLauncher({
    client: {
      async reportAgent() {},
      async run() {},
    },
    workerScript: "/worker.js",
    stateDirectory,
  });

  await assert.rejects(
    launcher.run({ taskId, workerId: "scout-left", paneId: "w1:p2", worktreePath }),
    (error) => error instanceof HerdrPaneWorkerProcessError && error.definitive === true,
  );
});

function workflowFor({
  store,
  launcher,
  loadCompleted = (workerId) => completed(workerId),
}) {
  let inspections = 0;
  return new ParallelCodexScoutsWorkflow({
    store,
    runtime: {
      backend: "codex-mcp",
      async loadCompleted({ artifactDirectory }) {
        const workerId = path.basename(artifactDirectory);
        return loadCompleted(workerId);
      },
    },
    worktreeManager: {
      async inspect() {
        inspections += 1;
        return {
          worktreePath,
          headSha,
          branch: "shipmates/parallel",
          dirty: false,
          changes: [],
          inspections,
        };
      },
    },
    panePool: {
      async select() {
        return [{ paneId: "w1:p2" }, { paneId: "w1:p3" }];
      },
    },
    paneLauncher: launcher,
    paneCwd: "/shipmates",
  });
}

async function runningLeasedTask(t) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "parallel-scouts-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new TaskStore({ rootDir });
  await store.createTask({
    taskId,
    kind: "scout",
    repo: "johntango/Shipmates-Practice",
    baseSha: headSha,
    actor: "firstmate",
    eventId: "created",
  });
  for (const [from, to] of [
    ["proposed", "clarified"],
    ["clarified", "approved_for_dispatch"],
    ["approved_for_dispatch", "preparing"],
  ]) {
    await store.transition({ taskId, from, to, actor: "firstmate", eventId: to });
  }
  await store.requestWorktreeLease({
    taskId,
    actor: "firstmate",
    repoPath: "/repos/practice",
    baseSha: headSha,
    eventId: "lease-request",
  });
  await store.recordWorktreeLease({
    taskId,
    actor: "firstmate",
    requestEventId: "lease-request",
    repoPath: "/repos/practice",
    worktreePath,
    headSha,
    branch: "shipmates/parallel",
    eventId: "leased",
  });
  await store.transition({
    taskId,
    from: "preparing",
    to: "running",
    actor: "firstmate",
    eventId: "running",
  });
  return store;
}

function completed(workerId) {
  return {
    threadId: `thread-${workerId}`,
    eventCount: 1,
    report: {
      taskId,
      status: "completed",
      summary: `${workerId} completed`,
      branch: null,
      commit: null,
      files: ["index.js"],
      tests: [],
      risks: [],
    },
  };
}

function pane(paneId, { agent = null } = {}) {
  return {
    paneId,
    tabId: "w1:t1",
    workspaceId: "w1",
    cwd: "/repo",
    agentStatus: agent ? "working" : "unknown",
    agent,
  };
}

function processInfo(paneId, name, pid, shellPid) {
  return {
    paneId,
    shellPid,
    foregroundProcesses: [{ pid, name, argv: [name], cwd: "/repo" }],
  };
}
