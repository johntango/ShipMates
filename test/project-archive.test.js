import assert from "node:assert/strict";
import test from "node:test";

import { ProjectArchiveWorkflow } from "../src/workflows/project-archive.js";

test("archives only a completed project with verified merge and returned worktree", async () => {
  let archived = null;
  const project = {
    id: "project-1", name: "Demo", repo: "owner/demo", status: "approved",
    tasks: [{ id: "build", title: "Build", status: "completed", taskId: "task-1", previousTaskIds: [] }],
  };
  const snapshot = {
    id: "task-1", state: "complete", worktree: { status: "returned" },
    githubMerges: [{ status: "completed", prNumber: 7, headSha: "a", result: { merged: true, mergeCommitSha: "b" } }],
    postMergeAssurances: [{ eventId: "assurance-1", mergeCommitSha: "b", requiredChecks: { satisfied: true } }],
    branchCleanups: [{ status: "completed", completedEventId: "cleanup-1" }],
  };
  const removed = [];
  const workflow = new ProjectArchiveWorkflow({
    projectStore: {
      async get() { return project; }, async list() { return [project]; },
      async archive({ receipt }) { archived = receipt; return { ...project, status: "archived", archiveReceipt: receipt }; },
    },
    taskStore: { async getSnapshot() { return snapshot; } },
    stateRoot: "/state",
    clock: () => new Date("2026-07-16T20:00:00Z"),
    remove: async (target) => removed.push(target),
  });
  const result = await workflow.archive({ projectId: project.id });
  assert.equal(result.project.status, "archived");
  assert.equal(archived.recoverability.prNumber, 7);
  assert.equal(archived.recoverability.remoteVerified, true);
  assert.equal(archived.recoverability.branchCleanupEventId, "cleanup-1");
  assert.equal(removed.length, 3);
});

test("refuses archival before verified merge recovery exists", async () => {
  const project = { id: "project-1", name: "Demo", tasks: [{ status: "completed", taskId: "task-1", previousTaskIds: [] }] };
  const workflow = new ProjectArchiveWorkflow({
    projectStore: { async get() { return project; } },
    taskStore: { async getSnapshot() { return { state: "complete", worktree: { status: "leased" } }; } },
    stateRoot: "/state", remove: async () => {},
  });
  await assert.rejects(() => workflow.archive({ projectId: project.id }), /verified merged task/u);
});
