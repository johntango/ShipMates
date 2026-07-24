import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { RepositoryPurgeWorkflow } from "../src/workflows/repository-purge.js";

function project({ pid } = {}) {
  return {
    id: "project-demo", name: "DemoTest3", status: "blocked", repo: "owner/demo",
    repoPath: "/repos/demo", tasks: [{
      taskId: "task-current", previousTaskIds: ["task-old"],
      attempts: pid ? [{ taskId: "task-current", launchReceipt: { pid } }] : [],
    }],
  };
}

test("requires a fresh preview token and permanently removes generated state", async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "purge-workflow-"));
  await mkdir(path.join(stateRoot, "firstmate-conversation"), { recursive: true });
  await writeFile(path.join(stateRoot, "firstmate-conversation", "turn-demo.json"),
    JSON.stringify({ project: "DemoTest3", taskId: "task-current" }));
  await writeFile(path.join(stateRoot, "firstmate-conversation", "turn-other.json"),
    JSON.stringify({ project: "KeepMe" }));
  await writeFile(path.join(stateRoot, "active-project.json"),
    JSON.stringify({ taskId: "task-current" }));
  const removedWorktrees = [];
  let released = false;
  let purged = false;
  const workflow = new RepositoryPurgeWorkflow({
    stateRoot,
    projectStore: {
      repository: async () => ({ repoPath: "/repos/demo", projects: [project()] }),
      purgeRepository: async () => { purged = true; },
    },
    taskStore: { getSnapshot: async (taskId) => ({
      worktree: taskId === "task-current"
        ? { status: "leased", worktreePath: path.join(stateRoot, "worktrees", taskId) }
        : null,
    }) },
    processRunning: async () => false,
    removeWorktree: async ({ worktreePath }) => removedWorktrees.push(worktreePath),
    visibility: { release: async () => { released = true; } },
  });

  const preview = await workflow.preview("DemoTest3");
  assert.equal(preview.eligible, true);
  assert.deepEqual(preview.taskIds, ["task-current", "task-old"]);
  await assert.rejects(() => workflow.purge({ query: "DemoTest3", confirmationId: "wrong" }),
    /exact current preview/u);
  const result = await workflow.purge({ query: "DemoTest3", confirmationId: preview.confirmationId });

  assert.equal(result.purged, true);
  assert.equal(result.githubChanged, false);
  assert.equal(result.checkoutChanged, false);
  assert.equal(purged, true);
  assert.equal(released, true);
  assert.equal(removedWorktrees.length, 1);
  await assert.rejects(() => readFile(path.join(stateRoot, "firstmate-conversation", "turn-demo.json")),
    { code: "ENOENT" });
  assert.match(await readFile(path.join(stateRoot, "firstmate-conversation", "turn-other.json"), "utf8"), /KeepMe/u);
  await assert.rejects(() => readFile(path.join(stateRoot, "active-project.json")), { code: "ENOENT" });
});

test("refuses purge while a recorded project process is alive", async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "purge-live-"));
  const workflow = new RepositoryPurgeWorkflow({
    stateRoot,
    projectStore: {
      repository: async () => ({ repoPath: "/repos/demo", projects: [project({ pid: 4242 })] }),
      purgeRepository: async () => assert.fail("must not purge"),
    },
    taskStore: { getSnapshot: async () => ({}) },
    processRunning: async (pid) => pid === 4242,
  });
  const preview = await workflow.preview("DemoTest3");
  assert.equal(preview.eligible, false);
  assert.match(preview.blockers.join(" "), /live project processes/u);
  await assert.rejects(() => workflow.purge({
    query: "DemoTest3", confirmationId: preview.confirmationId,
  }), /purge refused/u);
});
