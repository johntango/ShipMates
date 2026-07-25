import assert from "node:assert/strict";
import test from "node:test";

import { parseDoctorArgs, renderDoctorReport } from "../src/cli/doctor.js";
import { ShipMatesDoctor } from "../src/doctor/system-doctor.js";

test("doctor observes a clean registered project without mutation", async () => {
  const calls = [];
  const report = await new ShipMatesDoctor({
    projectStore: {
      target: "/state/projects.json",
      list: async (options) => { calls.push(["projects", options]); return [project()]; },
    },
    taskStore: {
      listTaskIds: async () => { calls.push(["task ids"]); return ["task-one"]; },
      getSnapshot: async (taskId) => { calls.push(["snapshot", taskId]); return snapshot(); },
    },
    observer: observer(),
    clock: () => new Date("2026-07-25T12:00:00.000Z"),
  }).inspect();

  assert.equal(report.clean, true);
  assert.equal(report.readOnly, true);
  assert.equal(report.summary.tasks, 1);
  assert.equal(report.projects[0].tasks[0].attempts[0].snapshot, undefined);
  assert.equal(report.projects[0].tasks[0].attempts[0].ledger.state, "complete");
  assert.deepEqual(calls, [["projects", { includeArchived: true }], ["snapshot", "task-one"]]);
});

test("reports stale completion, missing processes, and exact recovery commands", async () => {
  const source = project();
  source.tasks[0].status = "dispatched";
  source.tasks[0].attempts[0].status = "dispatched";
  source.tasks[0].attempts[0].launchReceipt = { kind: "process", pid: 4242 };
  const report = await fixture({ project: source, snapshot: snapshot({ state: "complete" }), processRunning: false });
  assert.equal(report.clean, false);
  assert.deepEqual(report.findings.map(({ code }) => code).sort(), [
    "completed_task_still_active", "worker_process_missing",
  ]);
  const completion = report.findings.find(({ code }) => code === "completed_task_still_active");
  assert.match(completion.recovery.instruction, /do not redispatch/u);
});

test("reports missing and corrupt ledgers and registry invariants", async () => {
  const source = project();
  source.tasks[0].status = "blocked";
  source.tasks[0].blockingReason = null;
  const missing = await fixture({ project: source, snapshot: null });
  assert.equal(missing.findings.some(({ code }) => code === "registry_missing_blocking_reason"), true);
  assert.equal(missing.findings.some(({ code }) => code === "task_ledger_missing"), true);

  const corrupt = await fixture({ project: project(), snapshotError: new Error("bad JSONL") });
  assert.equal(corrupt.findings.some(({ code, message }) => code === "task_ledger_unreadable" && /bad JSONL/u.test(message)), true);
  assert.equal(corrupt.findings.some(({ code }) => code === "task_ledger_missing"), false);
});

test("observes registry processes when the ledger is unreadable", async () => {
  const source = project();
  source.tasks[0].attempts[0].status = "dispatched";
  source.tasks[0].attempts[0].launchReceipt = { kind: "process", pid: 4242 };
  const report = await fixture({ project: source, snapshotError: new Error("bad JSONL"), processRunning: false });
  assert.equal(report.findings.some(({ code }) => code === "worker_process_missing"), true);
  assert.equal(report.projects[0].tasks[0].attempts[0].process.running, false);
});

test("caps report collections and exposes deterministic truncation metadata", async () => {
  const source = project();
  source.tasks[0].attempts = Array.from({ length: 25 }, (_, index) => ({
    taskId: `task-${index}`, status: "completed", blockingReason: null,
  }));
  const report = await fixture({ project: source });
  assert.equal(report.projects[0].tasks[0].attempts.length, 20);
  assert.deepEqual(report.projects[0].tasks[0].truncation.attempts, {
    limit: 20, total: 25, omitted: 5, truncated: true,
  });
});

test("reports worktree uncertainty, validation uncertainty, and absent destinations", async () => {
  const active = snapshot({ state: "validating" });
  active.worktree = { status: "leased", repoPath: "/repos/demo", worktreePath: "/trees/task-one", headSha: "a".repeat(40) };
  active.validationRequests = [{ eventId: "validation-request" }];
  const report = await fixture({
    snapshot: active,
    repository: { path: "/repos/demo", exists: false },
    worktrees: { repoPath: "/repos/demo", entries: null, error: "treehouse unavailable" },
  });
  const codes = report.findings.map(({ code }) => code);
  assert.equal(codes.includes("registered_repository_missing"), true);
  assert.equal(codes.includes("validation_result_missing"), true);
  assert.equal(codes.includes("worktrees_unobservable"), true);
});

test("filters by project and task and renders structured human output", async () => {
  assert.deepEqual(parseDoctorArgs(["--project", "Demo", "--task", "task-one", "--json"]), {
    project: "Demo", task: "task-one", json: true,
  });
  assert.throws(() => parseDoctorArgs(["--project"]), /requires a value/u);
  assert.throws(() => parseDoctorArgs(["--write"]), /Unknown doctor option/u);
  const report = await fixture({ projectFilter: "Demo", taskFilter: "task-one" });
  assert.match(renderDoctorReport(report), /inspected read-only/u);
});

async function fixture({
  project: source = project(), snapshot: taskSnapshot = snapshot(), snapshotError = null,
  taskIds = ["task-one"], processRunning = true,
  repository = { path: "/repos/demo", exists: true, headSha: "a".repeat(40), clean: true, changes: [] },
  worktrees = { repoPath: "/repos/demo", entries: [] },
  projectFilter = null, taskFilter = null,
} = {}) {
  return new ShipMatesDoctor({
    projectStore: { target: "/state/projects.json", list: async () => [source] },
    taskStore: {
      listTaskIds: async () => taskIds,
      getSnapshot: async (taskId) => {
        if (snapshotError) throw snapshotError;
        if (taskId === "orphan-task") return {
          id: taskId, state: "running", firstmateRuns: [{ status: "classified" }],
          validationRequests: [], validationRuns: [],
        };
        return taskSnapshot;
      },
    },
    observer: observer({ repository, worktrees, processRunning }),
  }).inspect({ project: projectFilter, task: taskFilter });
}

function observer({
  repository = { path: "/repos/demo", exists: true, headSha: "a".repeat(40), clean: true, changes: [] },
  worktrees = { repoPath: "/repos/demo", entries: [] }, processRunning = true,
} = {}) {
  return {
    repository: async () => repository,
    worktrees: async () => worktrees,
    worktree: async (worktreePath) => ({
      worktreePath, headSha: "a".repeat(40), branch: null, dirty: false, changes: [],
    }),
    process: async (pid) => ({ pid, running: processRunning }),
  };
}

function project() {
  return {
    id: "project-demo", name: "Demo", repo: "owner/demo", repoPath: "/repos/demo",
    status: "completed", tasks: [{
      id: "plan-one", title: "Task one", status: "completed", taskId: "task-one",
      blockingReason: null, dependsOn: [], previousTaskIds: [],
      attempts: [{ taskId: "task-one", status: "completed", blockingReason: null }],
    }],
  };
}

function snapshot(overrides = {}) {
  return {
    id: "task-one", state: "complete", worktree: null,
    validationRequests: [], validationRuns: [], ...overrides,
  };
}
