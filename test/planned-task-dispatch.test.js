import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ProjectStore } from "../src/projects/project-store.js";
import { PlannedTaskDispatcher } from "../src/workflows/planned-task-dispatch.js";

test("selects, claims, dispatches, and returns one durable task", async () => {
  const { store, project } = await fixture();
  const selected = [];
  const dispatcher = new PlannedTaskDispatcher({
    projectStore: store,
    selectProject: async (id) => { selected.push(id); return store.activate(id); },
    dispatchRequest: async () => {
      await store.attachTask({
        projectId: project.id, planTaskId: "build", taskId: "task-durable", title: "Build",
      });
      await store.recordLaunchReceipt({
        projectId: project.id, planTaskId: "build", taskId: "task-durable",
        receipt: { kind: "process", pid: 1234 },
      });
    },
  });
  const result = await dispatcher.dispatchNext({ projectId: project.id });
  assert.equal(result.status, "dispatched");
  assert.equal(result.task.taskId, "task-durable");
  assert.deepEqual(selected, [project.id]);
});

test("blocks a claimed task when dispatch returns without durable attachment", async () => {
  const { store, project } = await fixture();
  const dispatcher = new PlannedTaskDispatcher({
    projectStore: store,
    selectProject: (id) => store.activate(id),
    dispatchRequest: async () => {},
  });
  const result = await dispatcher.dispatchNext({ projectId: project.id });
  assert.equal(result.status, "blocked");
  assert.equal(result.task.taskId, null);
  assert.match(result.task.blockingReason, /durable task/u);
});

test("retries exactly the requested blocked task and preserves attempt history", async () => {
  const { store, project } = await fixture();
  await store.attachTask({
    projectId: project.id, planTaskId: "build", taskId: "task-old", title: "Build",
  });
  await store.updateTaskStatus({
    projectId: project.id, planTaskId: "build", status: "blocked", blockingReason: "stalled",
  });
  const dispatcher = new PlannedTaskDispatcher({
    projectStore: store,
    selectProject: (id) => store.activate(id),
    dispatchRequest: async () => {
      await store.attachTask({
        projectId: project.id, planTaskId: "build", taskId: "task-new", title: "Build",
      });
      await store.recordLaunchReceipt({
        projectId: project.id, planTaskId: "build", taskId: "task-new",
        receipt: { kind: "pane", paneId: "w1:p2" },
      });
    },
  });
  const result = await dispatcher.retryBlocked({ projectId: project.id, planTaskId: "build" });
  assert.equal(result.task.taskId, "task-new");
  assert.deepEqual(result.task.previousTaskIds, ["task-old"]);
});

test("blocks an attached task that has no exact launch identity", async () => {
  const { store, project } = await fixture();
  const dispatcher = new PlannedTaskDispatcher({
    projectStore: store,
    selectProject: (id) => store.activate(id),
    dispatchRequest: async () => store.attachTask({
      projectId: project.id, planTaskId: "build", taskId: "task-no-receipt", title: "Build",
    }),
  });
  const result = await dispatcher.dispatchNext({ projectId: project.id });
  assert.equal(result.status, "blocked");
  assert.match(result.task.blockingReason, /process or pane launch receipt/u);
});

async function fixture() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "planned-dispatch-"));
  const store = new ProjectStore({ rootDir });
  let project = await store.create({
    name: "Demo", repo: "owner/demo", repoPath: "/repo/demo", baseSha: "abc123",
  });
  project = await store.savePlan({
    projectId: project.id, objective: "Build it",
    tasks: [{ id: "build", title: "Build", description: "Build it", dependsOn: [] }],
  });
  project = await store.approve(project.id);
  return { store, project };
}
