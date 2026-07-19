import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskStore } from "../src/storage/task-store.js";
import { prepareFirstmateLocalWrite } from "../src/workflows/firstmate-local-write.js";

const taskId = "firstmate-write-task";
const headSha = "a".repeat(40);

test("advances a clarified local-write task into an exact Treehouse lease", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "firstmate-local-write-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new TaskStore({ rootDir });
  await store.createTask({
    taskId,
    kind: "firstmate-intake",
    repo: "johntango/ShipMates",
    baseSha: headSha,
    actor: "firstmate",
    eventId: "created",
  });
  await store.transition({
    taskId,
    from: "proposed",
    to: "clarified",
    actor: "firstmate",
    eventId: "clarified",
  });
  const calls = [];
  const manager = {
    async prepareRepository(input) { calls.push(["prepare", input]); },
    async lease(input) {
      calls.push(["lease", input]);
      return {
        taskId,
        repoPath: "/repos/shipmates",
        worktreePath: "/tmp/treehouse/shipmates/repo",
      };
    },
    async inspect(input) {
      calls.push(["inspect", input]);
      return {
        worktreePath: "/tmp/treehouse/shipmates/repo",
        headSha,
        branch: null,
        dirty: false,
        changes: [],
      };
    },
    async alignLeaseBase(input) {
      calls.push(["align", input]);
      return {
        worktreePath: "/tmp/treehouse/shipmates/repo",
        headSha,
        branch: null,
        dirty: false,
        changes: [],
      };
    },
    async prepareTaskBranch(input) {
      calls.push(["prepare-branch", input]);
      return {
        branch: `agent/${taskId}`,
        headSha,
        dirty: false,
        changedPaths: [],
      };
    },
    async inspectPreparedTaskBranch(input) {
      calls.push(["inspect-branch", input]);
      return {
        branch: `agent/${taskId}`,
        headSha,
        dirty: false,
        changedPaths: [],
      };
    },
  };

  const first = await prepareFirstmateLocalWrite({
    store,
    manager,
    taskId,
    requestId: "request-local-write",
    repoPath: "/repos/shipmates",
  });
  assert.equal(first.state, "running");
  assert.equal(first.worktree.status, "leased");
  assert.equal(first.worktree.headSha, headSha);
  assert.equal(first.worktree.branch, `agent/${taskId}`);
  assert.equal(first.worktree.worktreePath, "/tmp/treehouse/shipmates/repo");
  assert.deepEqual(calls.map(([name]) => name), [
    "prepare", "lease", "align", "prepare-branch",
  ]);

  const events = first.eventsCount;
  const second = await prepareFirstmateLocalWrite({
    store,
    manager,
    taskId,
    requestId: "request-local-write",
    repoPath: "/repos/shipmates",
  });
  assert.equal(second.eventsCount, events);
  assert.equal(calls.length, 4);
});

test("passes local-only demo preparation to Treehouse", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "firstmate-local-demo-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new TaskStore({ rootDir });
  await store.createTask({ taskId, kind: "firstmate-intake", repo: "owner/demo", baseSha: headSha, actor: "firstmate" });
  await store.transition({ taskId, from: "proposed", to: "clarified", actor: "firstmate" });
  let localOnly = null;
  const manager = {
    async prepareRepository(input) { localOnly = input.localOnly; },
    async lease(input) { assert.equal(input.localOnly, true); return { taskId, repoPath: "/repos/demo", worktreePath: "/tmp/demo" }; },
    async alignLeaseBase() { return { worktreePath: "/tmp/demo", headSha, branch: null, dirty: false, changes: [] }; },
    async prepareTaskBranch() { return { branch: `agent/${taskId}`, headSha, dirty: false, changedPaths: [] }; },
    async inspectPreparedTaskBranch() { return { branch: `agent/${taskId}`, headSha, dirty: false, changedPaths: [] }; },
  };
  await prepareFirstmateLocalWrite({ store, manager, taskId, requestId: "demo-request", repoPath: "/repos/demo", localOnly: true });
  assert.equal(localOnly, true);
});
