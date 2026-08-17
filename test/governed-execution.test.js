import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ProjectStore } from "../src/projects/project-store.js";
import {
  verifyGovernedExecutionEnvelope,
  writeGovernedExecutionEnvelope,
} from "../src/workflows/governed-execution.js";

test("verifies one durable envelope against its approved dispatched plan attempt", async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "governed-execution-"));
  const projectStore = new ProjectStore({ rootDir: stateRoot });
  let project = await projectStore.create({
    name: "Demo", repo: "owner/demo", repoPath: "/repo/demo", baseSha: "abc123",
  });
  project = await projectStore.savePlan({
    projectId: project.id, objective: "Build it",
    tasks: [{ id: "build", title: "Build", description: "Build it", dependsOn: [] }],
  });
  await projectStore.approve(project.id);
  await projectStore.claimNextReady(project.id);
  await projectStore.attachTask({
    projectId: project.id, planTaskId: "build", taskId: "task-build", title: "Build",
  });
  const envelope = {
    schemaVersion: 1, projectId: project.id, planTaskId: "build",
    taskId: "task-build", requestId: "request-build", repo: "owner/demo",
    baseSha: "abc123", instruction: "Build it", authority: "local_write",
  };
  const filePath = await writeGovernedExecutionEnvelope({ stateRoot, envelope });

  assert.deepEqual(await verifyGovernedExecutionEnvelope({
    filePath, expected: {
      taskId: "task-build", requestId: "request-build", repo: "owner/demo",
      baseSha: "abc123", instruction: "Build it", authority: "local_write",
    }, projectStore,
  }), envelope);
});

test("rejects mismatched and unapproved governed execution envelopes", async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "governed-execution-reject-"));
  const envelope = {
    schemaVersion: 1, projectId: "project-one", planTaskId: "build",
    taskId: "task-build", requestId: "request-build", repo: "owner/demo",
    baseSha: "abc123", instruction: "Build it", authority: "local_write",
  };
  const filePath = await writeGovernedExecutionEnvelope({ stateRoot, envelope });
  const planningProject = { id: "project-one", status: "planning", tasks: [{
    id: "build", status: "dispatched", taskId: "task-build",
    attempts: [{ taskId: "task-build" }],
  }] };
  await assert.rejects(() => verifyGovernedExecutionEnvelope({
    filePath, expected: { ...envelope, instruction: "Different" },
    projectStore: { get: async () => planningProject },
  }), /mismatches instruction/u);
  await assert.rejects(() => verifyGovernedExecutionEnvelope({
    filePath, expected: envelope,
    projectStore: { get: async () => planningProject },
  }), /not bound to an approved dispatched plan task/u);
});
