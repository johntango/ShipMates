import assert from "node:assert/strict";
import test from "node:test";

import { ProjectOrchestrator } from "../src/workflows/project-orchestrator.js";

test("inspects the existing attempt and returns a deterministic recovery action", async () => {
  const taskStore = { async getSnapshot() {
    return { id: "task-one", state: "awaiting_worker", workers: [
      { id: "implementer", status: "started" },
    ], validationRuns: [], validationRequests: [] };
  } };
  const projectStore = {
    async describeAttempt() { return { projectName: "TestA", attempt: { taskId: "task-one" } }; },
  };
  const result = await new ProjectOrchestrator({ taskStore, projectStore }).inspectTask("task-one");
  assert.equal(result.recovery.action, "reconcile_worker");
  assert.equal(result.context.projectName, "TestA");
});

test("startup reconciliation records an exact blocker without creating an attempt", async () => {
  const updates = [];
  const project = { id: "project-one", demoMode: true, tasks: [{
    id: "validation", taskId: "task-one", status: "dispatched", attempts: [
      { taskId: "task-one", status: "dispatched" },
    ],
  }] };
  const taskStore = { async getSnapshot() {
    return {
      id: "task-one", state: "blocked", validationRuns: [{
        passed: false, outcome: "failed", findings: [{ message: "Wrap test failed" }],
      }], validationRequests: [], workers: [],
    };
  } };
  const projectStore = {
    async get() { return project; },
    async describeAttempt() { return { projectName: "TestA", attempt: project.tasks[0].attempts[0] }; },
    async updateTaskStatus(input) { updates.push(input); return project; },
  };
  const results = await new ProjectOrchestrator({ taskStore, projectStore })
    .reconcileProject("project-one");
  assert.equal(results[0].action, "repair_existing");
  assert.equal(updates[0].blockingReason, "Wrap test failed");
  assert.equal(project.tasks[0].attempts.length, 1);
});

test("startup reconciliation blocks a dispatched project task whose intake failed", async () => {
  const updates = [];
  const project = {
    id: "project-intake", status: "active", demoMode: true,
    tasks: [{ id: "build", taskId: "task-intake", status: "dispatched", blockingReason: null }],
  };
  const orchestrator = new ProjectOrchestrator({
    taskStore: { async getSnapshot() { return {
      id: "task-intake", state: "proposed", workers: [], validationRuns: [], validationRequests: [],
      firstmateRuns: [{ status: "failed", failure: { message: "Classification connection failed" } }],
    }; } },
    projectStore: {
      async get() { return project; },
      async describeAttempt() { return { projectId: project.id, planTaskId: "build" }; },
      async updateTaskStatus(input) { updates.push(input); },
    },
  });
  const [result] = await orchestrator.reconcileProject(project.id);
  assert.equal(result.status, "blocked");
  assert.equal(updates[0].status, "blocked");
  assert.match(updates[0].blockingReason, /connection failed/iu);
});

test("does not rewrite an unchanged blocker on every monitor pass", async () => {
  let updates = 0;
  const reason = "Wrap test failed";
  const project = { id: "project-one", demoMode: true, tasks: [{
    id: "validation", taskId: "task-one", status: "blocked", blockingReason: reason,
    attempts: [{ taskId: "task-one", status: "blocked" }],
  }] };
  const taskStore = { async getSnapshot() {
    return { id: "task-one", state: "blocked", validationRuns: [{
      passed: false, outcome: "failed", findings: [{ message: reason }],
    }], validationRequests: [], workers: [] };
  } };
  const projectStore = {
    async get() { return project; },
    async describeAttempt() { return { attempt: project.tasks[0].attempts[0] }; },
    async updateTaskStatus() { updates += 1; },
  };
  await new ProjectOrchestrator({ taskStore, projectStore }).reconcileProject("project-one");
  assert.equal(updates, 0);
});

test("reconciles an approval-gated validation without treating it as failure", async () => {
  const updates = [];
  const transitions = [];
  const project = { id: "project-one", demoMode: false, tasks: [{
    id: "validate", taskId: "task-one", status: "blocked",
    blockingReason: "validation failed",
    attempts: [{ taskId: "task-one", status: "blocked" }],
  }] };
  const snapshot = {
    id: "task-one",
    state: "validating",
    workers: [],
    validationRequests: [],
    validationRuns: [{
      passed: false,
      gate: { step: "review", status: "awaiting_approval" },
    }],
  };
  const orchestrator = new ProjectOrchestrator({
    taskStore: {
      async getSnapshot() { return snapshot; },
      async transition(input) {
        transitions.push(input);
        return { ...snapshot, state: input.to };
      },
    },
    projectStore: {
      async get() { return project; },
      async describeAttempt() { return { attempt: project.tasks[0].attempts[0] }; },
      async updateTaskStatus(input) { updates.push(input); return project; },
    },
  });

  const [result] = await orchestrator.reconcileProject(project.id);
  assert.equal(result.status, "awaiting_human");
  assert.equal(result.action, "request_validation_approval");
  assert.equal(transitions[0].to, "awaiting_human");
  assert.equal(updates[0].status, "dispatched");
  assert.equal(updates[0].blockingReason, undefined);
});

test("dismisses only an attempt with no execution evidence", async () => {
  let transitioned = false;
  const taskStore = {
    async getSnapshot() { return { id: "task-one", state: "preparing", worktree: null, workers: [] }; },
    async transition(input) { transitioned = true; return { id: input.taskId, state: input.to }; },
  };
  let detached = false;
  const projectStore = {
    async detachUnstartedAttempt() { detached = true; return { id: "project-one" }; },
  };
  const result = await new ProjectOrchestrator({ taskStore, projectStore }).dismissUnstartedAttempt({
    projectId: "project-one", planTaskId: "plan-1", taskId: "task-one",
  });
  assert.equal(result.snapshot.state, "cancelled");
  assert.equal(transitioned, true);
  assert.equal(detached, true);
});
