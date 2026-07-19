import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  buildDashboardState,
  ShipMatesDashboardServer,
  validateDashboardCommand,
  validateProjectAction,
} from "../src/dashboard/server.js";

test("projects recent tasks and the active project without report prose leakage", async () => {
  const { store, projectContext } = fixture();

  const state = await buildDashboardState({ store, projectContext });

  assert.equal(state.activeProjectTaskId, "task-001");
  assert.equal(state.tasks[0].activeProject, true);
  assert.deepEqual(state.tasks[0].files, [{
    filename: "index.html",
    path: "/treehouse/task-001/index.html",
    html: true,
  }]);
  assert.deepEqual(state.tasks[0].workers, [{
    id: "implementer", status: "reported", mode: "ship",
  }]);
});

test("projects project plans and binds planned items to durable tasks", async () => {
  const { store, projectContext } = fixture();
  const state = await buildDashboardState({
    store, projectContext,
    projectStore: { list: async () => [{
      id: "project-001", name: "ShipMates", repo: "owner/ShipMates", repoPath: "/repo",
      objective: "Build the coordinator", status: "active", updatedAt: "2026-07-15T12:00:00Z",
      tasks: [{ id: "plan-1", title: "Build the website", description: "Implement it", status: "dispatched", dependsOn: [], taskId: "task-001" }],
    }] },
  });

  assert.equal(state.projects[0].tasks[0].status, "completed");
  assert.equal(state.projects[0].progress.completed, 1);
});

test("does not count blocked or recovery-required plan work as completed progress", async () => {
  const { store, projectContext } = fixture();
  const projects = [{
      id: "project-one", name: "Demo", repo: "owner/demo", repoPath: "/demo",
      objective: "Demo", status: "approved", updatedAt: "2026-07-17T00:00:00Z",
      tasks: [
        { id: "done", title: "Done", status: "completed", taskId: null },
        { id: "blocked", title: "Blocked", status: "blocked", taskId: null },
        { id: "recovery", title: "Recovery", status: "recovery_required", taskId: null },
      ],
    }];
  const state = await buildDashboardState({
    store, projectContext, projectStore: { list: async () => projects },
  });
  assert.deepEqual(state.projects[0].progress, {
    total: 3, completed: 1, active: 0, planned: 0,
  });
});

test("includes watchdog attention in the live dashboard state", async () => {
  const { store, projectContext } = fixture();
  const state = await buildDashboardState({
    store, projectContext,
    watchdog: { thresholdMs: 900_000, inspect: async () => [{
      taskId: "task-001", projectName: "BallsB", taskName: "Interaction",
      category: "overdue_process", status: "implementer overdue", remedy: "Refer to human",
      ageMinutes: 16, lastEventAt: "2026-07-15T12:00:00Z",
    }] },
  });
  assert.equal(state.watchdog.thresholdMinutes, 15);
  assert.equal(state.watchdog.alerts[0].projectName, "BallsB");
});

test("projects the persistent Project Agent owner", async () => {
  const { store, projectContext } = fixture();
  const state = await buildDashboardState({ store, projectContext, projectStore: {
    active: async () => null,
    list: async () => [{
      id: "project-a", name: "BallsA", repo: "owner/balls", repoPath: "/repo",
      objective: "Build balls", status: "paused", updatedAt: "2026-07-16T00:00:00Z", tasks: [],
      executionPolicy: { mode: "persistent_project", branch: "shipmates/ballsa", worktreePath: "/worktrees/BallsA" },
    }],
  } });
  assert.deepEqual(state.projects[0].owner, {
    kind: "project-agent", name: "ShipMates Project: BallsA",
    branch: "shipmates/ballsa", worktreePath: "/worktrees/BallsA",
  });
});

test("standalone dashboard entrypoint supplies the durable project registry", async () => {
  const source = await readFile(path.resolve("scripts/dashboard.js"), "utf8");
  assert.match(source, /new ProjectStore\(\{ rootDir: store\.rootDir \}\)/u);
  assert.match(source, /projectStore:/u);
});

test("starts through an injectable localhost listener", async (t) => {
  const { store, projectContext } = fixture();
  const listener = new EventEmitter();
  listener.address = () => ({ port: 4545 });
  listener.close = (callback) => callback();
  const server = new ShipMatesDashboardServer({
    store,
    projectContext,
    onCommand: async () => {},
    port: 0,
    listen: (_app, port, host) => {
      assert.equal(port, 0);
      assert.equal(host, "127.0.0.1");
      queueMicrotask(() => listener.emit("listening"));
      return listener;
    },
  });
  t.after(() => server.stop());
  assert.equal(await server.start(), "http://127.0.0.1:4545");
});

test("ships a Bootstrap page with light, dark, and system themes", async () => {
  const page = await readFile(path.resolve("src/dashboard/public/index.html"), "utf8");
  assert.match(page, /bootstrap\.min\.css/u);
  assert.match(page, /option value="system"/u);
  assert.match(page, /option value="light"/u);
  assert.match(page, /option value="dark"/u);
  assert.match(page, /Send to Firstmate/u);
});

test("accepts bounded human messages and rejects empty or control input", () => {
  assert.equal(validateDashboardCommand("  show me the files  "), "show me the files");
  for (const message of [" ", "bad\u0000command", "x".repeat(4_001)]) {
    assert.throws(() => validateDashboardCommand(message), /1-4000 printable/u);
  }
});

test("accepts only bounded project controls", () => {
  assert.deepEqual(validateProjectAction({ projectId: "project-001", action: "select" }), {
    projectId: "project-001", action: "select", planTaskId: null,
  });
  assert.deepEqual(validateProjectAction({ projectId: "project-001", action: "approve" }), {
    projectId: "project-001", action: "approve", planTaskId: null,
  });
  assert.deepEqual(validateProjectAction({
    projectId: "project-001", action: "priority_up", planTaskId: "plan-001",
  }), { projectId: "project-001", action: "priority_up", planTaskId: "plan-001" });
  assert.throws(() => validateProjectAction({ projectId: "project-001", action: "delete" }), /Invalid/u);
  assert.throws(() => validateProjectAction({ projectId: "project-001", action: "priority_up" }), /planned task/u);
});

function fixture() {
  const snapshot = {
    id: "task-001",
    state: "validating",
    lastEventAt: "2026-07-15T12:00:00.000Z",
    worktree: { worktreePath: "/treehouse/task-001" },
    firstmateRuns: [{ classification: {
      summary: "Build the website",
      requiredAuthority: "local_write",
    } }],
    workers: [{
      id: "implementer",
      status: "reported",
      mode: "ship",
      report: { files: ["index.html"] },
    }],
    validationRuns: [{ passed: true, outcome: "passed" }],
  };
  return {
    store: {
      listTaskIds: async () => [snapshot.id],
      getSnapshot: async () => snapshot,
    },
    projectContext: { load: async () => snapshot.id },
  };
}
