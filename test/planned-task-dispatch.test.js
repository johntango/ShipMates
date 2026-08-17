import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ProjectStore } from "../src/projects/project-store.js";
import { parseProjectApproval } from "../src/cli/firstmate-project-query.js";
import {
  claimPlannedTaskForDispatch,
  PlannedTaskDispatcher,
} from "../src/workflows/planned-task-dispatch.js";

test("selects, claims, dispatches, and returns one durable task", async () => {
  const { store, project } = await fixture();
  const selected = [];
  const dispatcher = new PlannedTaskDispatcher({
    projectStore: store,
    selectProject: async (id) => { selected.push(id); return store.activate(id); },
    dispatchRequest: async (_message, governed) => {
      assert.deepEqual(governed, {
        projectId: project.id, planTaskId: "build", requiredAuthority: "local_write",
        instruction: _message,
      });
      assert.equal((await store.get(project.id)).tasks[0].status, "claimed");
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

test("approval automatically claims and dispatches a short-id initial task", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "planned-approval-dispatch-"));
  const store = new ProjectStore({ rootDir });
  let project = await store.create({
    name: "DemoTest0", repo: "owner/demo", repoPath: "/repo/demo", baseSha: "abc123",
  });
  project = await store.savePlan({
    projectId: project.id, objective: "Build bouncing balls",
    tasks: [{ id: "ui", title: "Build page", description: "Add bouncing balls", dependsOn: [] }],
  });
  project = await store.approve(project.id);
  let launches = 0;
  const dispatcher = new PlannedTaskDispatcher({
    projectStore: store,
    selectProject: (id) => store.activate(id),
    dispatchRequest: async (_message, governed) => {
      launches += 1;
      assert.deepEqual(governed, {
        projectId: project.id, planTaskId: "ui", requiredAuthority: "local_write",
        instruction: _message,
      });
      assert.equal((await store.get(project.id)).tasks[0].status, "claimed");
      await store.attachTask({
        projectId: project.id, planTaskId: "ui", taskId: "task-ui", title: "Build page",
      });
      await store.recordLaunchReceipt({
        projectId: project.id, planTaskId: "ui", taskId: "task-ui",
        receipt: { kind: "process", pid: 4321 },
      });
    },
  });

  const result = await dispatcher.dispatchNext({ projectId: project.id });

  assert.equal(launches, 1);
  assert.equal(result.status, "dispatched");
  assert.equal(result.task.taskId, "task-ui");
});

test("ordinary explicit plan approval resumes and dispatches the initial task", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "planned-natural-approval-dispatch-"));
  const store = new ProjectStore({ rootDir });
  let project = await store.create({
    name: "DemoTest0", repo: "owner/demo", repoPath: "/repo/demo", baseSha: "abc123",
  });
  project = await store.savePlan({
    projectId: project.id, objective: "Build bouncing balls",
    tasks: [{ id: "page", title: "Build page", description: "Add bouncing balls", dependsOn: [] }],
  });
  const approval = parseProjectApproval("I approve the plan.", await store.list(), project);
  assert.equal(approval.project.id, project.id);
  project = await store.approve(approval.project.id);
  assert.equal(project.status, "approved");

  const dispatcher = new PlannedTaskDispatcher({
    projectStore: store,
    selectProject: (id) => store.activate(id),
    dispatchRequest: async (_message, governed) => {
      assert.equal(governed.planTaskId, "page");
      await store.attachTask({
        projectId: project.id, planTaskId: "page", taskId: "task-page", title: "Build page",
      });
      await store.recordLaunchReceipt({
        projectId: project.id, planTaskId: "page", taskId: "task-page",
        receipt: { kind: "process", pid: 9876 },
      });
    },
  });

  const result = await dispatcher.dispatchNext({ projectId: project.id });
  assert.equal(result.status, "dispatched");
  assert.equal(result.task.taskId, "task-page");
});

test("a conversational implementation decision claims its approved ready plan task", async () => {
  const { store, project } = await fixture();

  const task = await claimPlannedTaskForDispatch({
    projectStore: store, projectId: project.id, planTaskId: "build",
    requiredAuthority: "local_write",
  });

  assert.equal(task.status, "claimed");
  assert.equal((await store.get(project.id)).tasks[0].status, "claimed");
});

test("a conversational implementation decision cannot claim before plan approval", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "planned-unapproved-dispatch-"));
  const store = new ProjectStore({ rootDir });
  let project = await store.create({
    name: "Demo", repo: "owner/demo", repoPath: "/repo/demo", baseSha: "abc123",
  });
  project = await store.savePlan({
    projectId: project.id, objective: "Build it",
    tasks: [{ id: "ui", title: "Build", description: "Build it", dependsOn: [] }],
  });

  await assert.rejects(() => claimPlannedTaskForDispatch({
    projectStore: store, projectId: project.id, planTaskId: "ui",
    requiredAuthority: "local_write",
  }), /must be approved/u);
  assert.equal((await store.get(project.id)).tasks[0].status, "planned");
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
