import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveFirstmateControlIntent } from "../src/cli/firstmate-control-intent.js";
import { ProjectStore } from "../src/projects/project-store.js";
import { acceptFirstmateDemoWarning } from "../src/workflows/firstmate-demo-recovery.js";

test("accepts a browser-only demo warning on the existing blocked task without dispatch", async () => {
  const taskId = "task-existing123";
  let snapshot = {
    id: taskId, state: "blocked", evidence: [],
    workers: [{ id: "implementer", report: {
      status: "blocked", tests: [{ command: "node --test", result: "7 passed, 0 failures" }],
    } }],
  };
  const transitions = [];
  const store = {
    async getSnapshot() { return snapshot; },
    async recordEvidence(input) {
      snapshot = { ...snapshot, evidence: [...snapshot.evidence, { kind: input.kind }] };
      return snapshot;
    },
    async transition(input) {
      transitions.push([input.from, input.to]);
      assert.equal(snapshot.state, input.from);
      snapshot = { ...snapshot, state: input.to };
      return snapshot;
    },
  };
  let updated = null;
  const projectStore = {
    async describeTask() {
      return { projectId: "project-one", planTaskId: "validation" };
    },
    async get() { return { id: "project-one", demoMode: true }; },
    async updateTaskStatus(input) { updated = input; return { id: "project-one", demoMode: true }; },
  };

  const result = await acceptFirstmateDemoWarning({ store, projectStore, taskId });
  assert.equal(result.snapshot.state, "complete");
  assert.deepEqual(transitions, [
    ["blocked", "running"], ["running", "validating"],
    ["validating", "cleaning"], ["cleaning", "complete"],
  ]);
  assert.equal(updated.status, "completed");
  assert.equal(snapshot.workers.length, 1);
});

test("does not waive a reported failing local check", async () => {
  const store = {
    async getSnapshot() {
      return { id: "task-failed123", state: "blocked", evidence: [], workers: [{
        id: "implementer", report: { tests: [{ command: "tests", result: "1 failed" }] },
      }] };
    },
  };
  const projectStore = {
    async describeTask() { return { projectId: "project-one", planTaskId: "validation" }; },
    async get() { return { demoMode: true }; },
  };
  await assert.rejects(() => acceptFirstmateDemoWarning({
    store, projectStore, taskId: "task-failed123",
  }), /local check failed/u);
});

test("reconciles an approved demo warning end to end without a retry or plan row", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "demo-recovery-e2e-"));
  const projectStore = new ProjectStore({ rootDir });
  let project = await projectStore.create({
    name: "TestA", repo: "owner/demo", repoPath: "/repos/demo", baseSha: "abc123",
  });
  project = await projectStore.savePlan({ projectId: project.id, objective: "Demo", tasks: [
    { id: "tests", title: "Automated tests", description: "Tests", dependsOn: [] },
    { id: "validation", title: "Integration validation", description: "Validate", dependsOn: ["tests"] },
  ] });
  await projectStore.setDemoMode({ projectId: project.id });
  await projectStore.updateTaskStatus({ projectId: project.id, planTaskId: "tests", status: "completed" });
  await projectStore.attachTask({
    projectId: project.id, planTaskId: "validation",
    taskId: "task-validation123", title: "Integration validation",
  });
  await projectStore.updateTaskStatus({
    projectId: project.id, planTaskId: "validation", status: "blocked",
    blockingReason: "Browser validation unavailable",
  });
  let snapshot = {
    id: "task-validation123", state: "blocked", evidence: [],
    workers: [{ id: "implementer", report: {
      status: "blocked", tests: [{ command: "node --test", result: "7 passed, 0 failures" }],
    } }],
  };
  const taskStore = {
    async getSnapshot() { return snapshot; },
    async recordEvidence(input) {
      snapshot = { ...snapshot, evidence: [...snapshot.evidence, { kind: input.kind }] };
      return snapshot;
    },
    async transition(input) { snapshot = { ...snapshot, state: input.to }; return snapshot; },
  };
  const intent = await resolveFirstmateControlIntent({
    message: "Apply my accepted browser warning and complete task-validation123",
    projectStore,
  });
  assert.equal(intent.action, "accept_demo_warning");
  await acceptFirstmateDemoWarning({
    store: taskStore, projectStore, taskId: intent.taskId,
  });

  const finished = await projectStore.get(project.id);
  assert.equal(finished.tasks.length, 2);
  assert.equal(finished.tasks[1].status, "completed");
  assert.equal(finished.tasks[1].taskId, "task-validation123");
  assert.equal(finished.tasks[1].blockingReason, null);
});
