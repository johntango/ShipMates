import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ProjectStore } from "../src/projects/project-store.js";

test("registers repositories and persists a dependency-aware project plan", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "projects-"));
  const store = new ProjectStore({ rootDir, clock: () => new Date("2026-07-15T12:00:00Z") });
  const project = await store.ensureRepository({
    name: "ShipMates", repo: "owner/ShipMates", repoPath: "/repos/ShipMates", baseSha: "abc123",
  });
  await store.savePlan({ projectId: project.id, objective: "Build the coordinator", tasks: [
    { id: "foundation", title: "Foundation", description: "Create the model", dependsOn: [] },
    { id: "ui", title: "Dashboard", description: "Render the model", dependsOn: ["foundation"] },
  ] });
  await store.attachTask({ projectId: project.id, taskId: "task-001", title: "Implement it", planTaskId: "foundation" });

  const active = await store.active();
  assert.equal(active.objective, "Build the coordinator");
  assert.equal(active.tasks[0].taskId, "task-001");
  assert.equal(active.tasks[0].status, "dispatched");
  assert.deepEqual(active.tasks[1].dependsOn, ["foundation"]);
});

test("approves, pauses, prioritizes, and selects only dependency-ready work", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "project-controls-"));
  const store = new ProjectStore({ rootDir });
  const project = await store.ensureRepository({
    name: "Site", repo: "owner/site", repoPath: "/repos/site", baseSha: "abc123",
  });
  await store.savePlan({ projectId: project.id, objective: "Build site", tasks: [
    { id: "base", title: "Foundation", description: "Base", dependsOn: [] },
    { id: "page", title: "Page", description: "Page", dependsOn: ["base"] },
    { id: "docs", title: "Docs", description: "Docs", dependsOn: [] },
  ] });
  assert.equal((await store.approve(project.id)).status, "approved");
  assert.equal((await store.nextReady(project.id)).id, "base");
  await store.prioritize({ projectId: project.id, planTaskId: "docs", direction: "up" });
  await store.prioritize({ projectId: project.id, planTaskId: "docs", direction: "up" });
  assert.equal((await store.nextReady(project.id)).id, "docs");
  assert.equal((await store.setPaused(project.id, true)).status, "paused");
  await assert.rejects(() => store.nextReady(project.id), /approved and resumed/u);
  await store.setPaused(project.id, false);
  await store.updateTaskStatus({ projectId: project.id, planTaskId: "base", status: "completed" });
  await store.updateTaskStatus({ projectId: project.id, planTaskId: "docs", status: "completed" });
  assert.equal((await store.nextReady(project.id)).id, "page");
});

test("creates and selects independent projects in the same repository", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "same-repo-projects-"));
  const store = new ProjectStore({ rootDir });
  await store.ensureRepository({
    name: "Main", repo: "owner/app", repoPath: "/repos/app", baseSha: "abc123",
  });
  const second = await store.create({
    name: "TestBallProjects", repo: "owner/app", repoPath: "/repos/app", baseSha: "abc123",
  });

  assert.equal((await store.list()).length, 2);
  assert.equal((await store.active()).id, second.id);
  await assert.rejects(() => store.create({
    name: "testballprojects", repo: "owner/app", repoPath: "/repos/app", baseSha: "abc123",
  }), /already exists/u);
});

test("protects every project sharing a repository and records repository deletion", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "repository-lifecycle-"));
  const store = new ProjectStore({ rootDir });
  const first = await store.create({
    name: "TestA", repo: "owner/demo", repoPath: "/repos/demo", baseSha: "abc123",
  });
  const second = await store.create({
    name: "TestB", repo: "owner/demo", repoPath: "/repos/demo", baseSha: "abc123",
  });
  const protectedRepository = await store.setRepositoryProtected({ query: "TestA" });
  assert.equal(protectedRepository.projects.length, 2);
  assert.equal((await store.get(first.id)).protected, true);
  assert.equal((await store.get(second.id)).protected, true);
  await assert.rejects(() => store.recordRepositoryDeletion({
    repoPath: "/repos/demo", receipt: { schemaVersion: 1 },
  }), /is protected/u);

  await store.setRepositoryProtected({ query: "TestB", protected: false });
  const receipt = { schemaVersion: 1, repoPath: "/repos/demo", confirmationId: "1234567890abcdef" };
  const deleted = await store.recordRepositoryDeletion({ repoPath: "/repos/demo", receipt });
  assert.deepEqual(deleted.projects.map(({ name }) => name), ["TestA", "TestB"]);
  assert.equal((await store.list({ includeArchived: true })).length, 0);
});

test("pauses a uniquely matching project objective without changing selection", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "pause-project-"));
  const store = new ProjectStore({ rootDir });
  const first = await store.create({
    name: "Main", repo: "owner/app", repoPath: "/repos/app", baseSha: "abc123",
    objective: "Build the BallsA demonstration",
  });
  const selected = await store.create({
    name: "TestBallProjects", repo: "owner/app", repoPath: "/repos/app", baseSha: "abc123",
  });

  assert.equal((await store.pauseMatching("BallsA")).id, first.id);
  assert.equal((await store.get(first.id)).status, "paused");
  assert.equal((await store.active()).id, selected.id);
});

test("removes only projects with no dispatched task history and repairs selection", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "remove-project-"));
  const store = new ProjectStore({ rootDir });
  const retained = await store.create({
    name: "Retained", repo: "owner/app", repoPath: "/repos/app", baseSha: "abc123",
  });
  const removable = await store.create({
    name: "Removable", repo: "owner/app", repoPath: "/repos/app", baseSha: "abc123",
  });
  assert.equal((await store.remove(removable.id)).name, "Removable");
  assert.equal((await store.active()).id, retained.id);

  const protectedProject = await store.create({
    name: "Protected", repo: "owner/app", repoPath: "/repos/app", baseSha: "abc123",
  });
  await store.attachTask({ projectId: protectedProject.id, taskId: "task-001", title: "Work" });
  await assert.rejects(() => store.remove(protectedProject.id), /dispatched task history/u);
});

test("atomically claims a dependency-ready task only once", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "claim-project-"));
  const store = new ProjectStore({ rootDir });
  const project = await store.create({
    name: "Concurrent", repo: "owner/app", repoPath: "/repos/app", baseSha: "abc123",
  });
  await store.savePlan({ projectId: project.id, objective: "Build it", tasks: [
    { id: "setup", title: "Setup", description: "Setup", dependsOn: [] },
    { id: "page", title: "Page", description: "Page", dependsOn: ["setup"] },
  ] });
  await store.approve(project.id);

  const claims = await Promise.all([
    store.claimNextReady(project.id), store.claimNextReady(project.id),
  ]);
  assert.deepEqual(claims.map((claim) => claim?.id || null), ["setup", null]);
  assert.equal((await store.get(project.id)).tasks[0].status, "claimed");
});

test("recovers only claimed tasks that never received a durable task id", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "recover-claim-project-"));
  const store = new ProjectStore({ rootDir });
  const project = await store.create({
    name: "Recovery", repo: "owner/app", repoPath: "/repos/app", baseSha: "abc123",
  });
  await store.savePlan({ projectId: project.id, objective: "Build it", tasks: [
    { id: "orphan", title: "Orphan", description: "Orphan", dependsOn: [] },
    { id: "active", title: "Active", description: "Active", dependsOn: [] },
  ] });
  await store.approve(project.id);
  await store.claimNextReady(project.id);
  await store.updateTaskStatus({ projectId: project.id, planTaskId: "active", status: "claimed" });
  await store.attachTask({
    projectId: project.id, planTaskId: "active", taskId: "task-active", title: "Active",
  });

  const recovered = await store.recoverOrphanedClaims(project.id);
  const refreshed = await store.get(project.id);
  assert.deepEqual(recovered, [{ id: "orphan", title: "Orphan" }]);
  assert.equal(refreshed.tasks[0].status, "planned");
  assert.equal(refreshed.tasks[1].status, "dispatched");
  assert.equal(refreshed.tasks[1].taskId, "task-active");
});

test("binds the next planned task to its completed dependency task", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "project-lineage-"));
  const store = new ProjectStore({ rootDir });
  const project = await store.create({
    name: "Lineage", repo: "owner/app", repoPath: "/repos/app", baseSha: "abc123",
  });
  await store.savePlan({ projectId: project.id, objective: "Build it", tasks: [
    { id: "setup", title: "Setup", description: "Setup", dependsOn: [] },
    { id: "page", title: "Page", description: "Page", dependsOn: ["setup"] },
  ] });
  await store.attachTask({ projectId: project.id, planTaskId: "setup", taskId: "task-setup", title: "Setup" });
  await store.updateTaskStatus({ projectId: project.id, planTaskId: "setup", status: "completed" });

  assert.equal(await store.dependencyTaskId({ projectId: project.id, planTaskId: "page" }), "task-setup");
  assert.equal(await store.dependencyTaskId({ projectId: project.id, planTaskId: "setup" }), null);
});

test("describes a durable task using its project and planned-task names", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "describe-task-"));
  const store = new ProjectStore({ rootDir });
  const project = await store.create({
    name: "BallsA", repo: "owner/app", repoPath: "/repos/app", baseSha: "abc123",
  });
  await store.attachTask({ projectId: project.id, taskId: "task-001", title: "Build the interface" });

  assert.deepEqual(await store.describeTask("task-001"), {
    projectId: project.id, projectName: "BallsA", taskName: "Build the interface",
    planTaskId: "plan-1", ownerName: "ShipMates Firstmate",
  });
  assert.equal(await store.describeTask("task-missing"), null);
});

test("reattaches a blocked planned task without creating another plan row", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "retry-planned-task-"));
  const store = new ProjectStore({ rootDir });
  const project = await store.create({
    name: "BallsB", repo: "owner/balls", repoPath: "/repos/balls", baseSha: "abc123",
  });
  await store.savePlan({ projectId: project.id, objective: "Build it", tasks: [
    { id: "interaction", title: "Add interactions", description: "Controls", dependsOn: [] },
  ] });
  await store.attachTask({
    projectId: project.id, planTaskId: "interaction", taskId: "task-failed", title: "Add interactions",
  });
  await store.updateTaskStatus({ projectId: project.id, planTaskId: "interaction", status: "blocked" });
  await store.attachTask({
    projectId: project.id, planTaskId: "interaction", taskId: "task-retry", title: "Add interactions",
  });

  const retried = await store.get(project.id);
  assert.equal(retried.tasks.length, 1);
  assert.equal(retried.tasks[0].taskId, "task-retry");
  assert.equal(retried.tasks[0].status, "dispatched");
  assert.deepEqual(retried.tasks[0].attempts.map(({ taskId, status }) => ({ taskId, status })), [
    { taskId: "task-failed", status: "blocked" },
    { taskId: "task-retry", status: "dispatched" },
  ]);
});

test("migrates legacy current and previous task ids into attempt history", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "legacy-attempts-"));
  const store = new ProjectStore({ rootDir });
  const project = await store.create({
    name: "Legacy", repo: "owner/demo", repoPath: "/repos/demo", baseSha: "abc123",
  });
  await store.attachTask({ projectId: project.id, taskId: "task-current", title: "Work" });
  const loaded = await store.get(project.id);
  assert.deepEqual(loaded.tasks[0].attempts.map(({ taskId }) => taskId), ["task-current"]);
  assert.equal((await store.describeAttempt("task-current")).attempt.status, "dispatched");
});

test("plan revisions preserve attempt history and cannot remove executed tasks", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "revise-attempt-plan-"));
  const store = new ProjectStore({ rootDir });
  const project = await store.create({
    name: "Revision", repo: "owner/demo", repoPath: "/repos/demo", baseSha: "abc123",
  });
  await store.savePlan({ projectId: project.id, objective: "Initial", tasks: [
    { id: "setup", title: "Setup", description: "Initial setup", dependsOn: [] },
  ] });
  await store.attachTask({
    projectId: project.id, planTaskId: "setup", taskId: "task-setup", title: "Setup",
  });
  const revised = await store.savePlan({ projectId: project.id, objective: "Revised", tasks: [
    { id: "setup", title: "Setup", description: "Clarified setup", dependsOn: [] },
    { id: "verify", title: "Verify", description: "Check it", dependsOn: ["setup"] },
  ] });
  assert.equal(revised.tasks[0].taskId, "task-setup");
  assert.equal(revised.tasks[0].attempts.length, 1);
  await assert.rejects(() => store.savePlan({
    projectId: project.id, objective: "Bad revision", tasks: [
      { id: "verify", title: "Verify", description: "Check it", dependsOn: [] },
    ],
  }), /Cannot remove planned task setup/u);
});

test("detaches an unstarted fallback attempt and removes only its synthetic row", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "detach-unstarted-"));
  const store = new ProjectStore({ rootDir });
  const project = await store.create({
    name: "TestB", repo: "owner/demo", repoPath: "/repos/demo", baseSha: "abc123",
  });
  await store.attachTask({ projectId: project.id, taskId: "task-fallback", title: "Plan TestB" });
  const result = await store.detachUnstartedAttempt({
    projectId: project.id, planTaskId: "plan-1", taskId: "task-fallback",
  });
  assert.deepEqual(result.tasks, []);
});

test("refuses duplicate or unbound dispatches instead of creating plan-N rows", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "duplicate-planned-task-"));
  const store = new ProjectStore({ rootDir });
  const project = await store.create({
    name: "TestA", repo: "owner/demo", repoPath: "/repos/demo", baseSha: "abc123",
  });
  await store.savePlan({ projectId: project.id, objective: "Build it", tasks: [
    { id: "tests", title: "Add tests", description: "Coverage", dependsOn: [] },
  ] });
  await store.attachTask({
    projectId: project.id, planTaskId: "tests", taskId: "task-original", title: "Add tests",
  });

  await assert.rejects(() => store.attachTask({
    projectId: project.id, planTaskId: "tests", taskId: "task-duplicate", title: "Retry tests",
  }), /already dispatched.*resume its existing task/u);
  await assert.rejects(() => store.attachTask({
    projectId: project.id, taskId: "task-unbound", title: "Approve existing tests",
  }), /Unplanned work cannot be attached/u);
  const unchanged = await store.get(project.id);
  assert.equal(unchanged.tasks.length, 1);
  assert.equal(unchanged.tasks[0].taskId, "task-original");
});

test("stores and clears a planned task blocking reason", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "planned-task-blocker-"));
  const store = new ProjectStore({ rootDir });
  const project = await store.create({
    name: "TestA", repo: "owner/demo", repoPath: "/repos/demo", baseSha: "abc123",
  });
  await store.attachTask({ projectId: project.id, taskId: "task-one", title: "Validate" });
  await store.updateTaskStatus({
    projectId: project.id, planTaskId: "plan-1", status: "blocked",
    blockingReason: "Chrome launch requires approval",
  });
  assert.equal((await store.get(project.id)).tasks[0].blockingReason,
    "Chrome launch requires approval");
  await store.updateTaskStatus({ projectId: project.id, planTaskId: "plan-1", status: "completed" });
  assert.equal((await store.get(project.id)).tasks[0].blockingReason, null);
});

test("stores a persistent project execution policy", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "project-policy-"));
  const store = new ProjectStore({ rootDir });
  const project = await store.create({
    name: "BallsA", repo: "owner/balls", repoPath: "/repos/balls", baseSha: "abc123",
  });
  const updated = await store.setExecutionPolicy({ projectId: project.id, policy: {
    mode: "persistent_project", scouts: "none", validation: "milestone",
    branch: "shipmates/ballsa", worktreePath: path.join(rootDir, "BallsA"),
  } });
  assert.equal(updated.executionPolicy.mode, "persistent_project");
  assert.equal(updated.executionPolicy.scouts, "none");
  assert.equal(updated.executionPolicy.validation, "milestone");
  assert.equal(updated.executionPolicy.autoAdvance, true);
});

test("marks demo mode explicitly on one project", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "project-demo-mode-"));
  const store = new ProjectStore({ rootDir });
  const project = await store.create({
    name: "Demo", repo: "owner/demo", repoPath: "/repos/demo", baseSha: "abc123",
  });
  const updated = await store.setDemoMode({ projectId: project.id });
  assert.equal(updated.demoMode, true);
  assert.equal((await store.get(project.id)).demoMode, true);
});

test("resets blocked planned work while preserving its prior attempt", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "reset-blocked-"));
  const store = new ProjectStore({ rootDir });
  const project = await store.create({
    name: "BallsA", repo: "owner/balls", repoPath: "/repos/balls", baseSha: "abc123",
  });
  await store.savePlan({ projectId: project.id, objective: "Build it", tasks: [
    { id: "interface", title: "Interface", description: "UI", dependsOn: [] },
  ] });
  await store.attachTask({ projectId: project.id, planTaskId: "interface", taskId: "task-old", title: "Interface" });
  await store.updateTaskStatus({ projectId: project.id, planTaskId: "interface", status: "blocked" });
  const reset = await store.resetBlockedTask({ projectId: project.id, planTaskId: "interface" });
  assert.equal(reset.tasks[0].status, "planned");
  assert.equal(reset.tasks[0].taskId, null);
  assert.deepEqual(reset.tasks[0].previousTaskIds, ["task-old"]);
});
