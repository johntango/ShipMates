import path from "node:path";

import { TreehouseWorktreeManager } from "../src/adapters/treehouse.js";
import { TaskStore } from "../src/storage/task-store.js";
import { TaskBranchWorkflow } from "../src/workflows/task-branch.js";

const [command, taskId, ...rest] = process.argv.slice(2);
if (!new Set(["prepare", "reconcile"]).has(command) || !taskId || rest.length > 0) {
  throw new Error("Usage: firstmate-branch.js <prepare|reconcile> <task-id>");
}

const rootDir = path.resolve(process.env.SHIPMATES_STATE_DIR || ".shipmates");
const workflow = new TaskBranchWorkflow({
  store: new TaskStore({ rootDir }),
  manager: new TreehouseWorktreeManager(),
  actor: process.env.SHIPMATES_ACTOR || "firstmate",
});
const result = command === "prepare"
  ? await workflow.prepare({ taskId })
  : await workflow.reconcile({ taskId });

console.log(JSON.stringify({
  taskId,
  reused: result.reused,
  state: result.snapshot.state,
  worktree: {
    status: result.snapshot.worktree.status,
    branch: result.snapshot.worktree.branch,
    headSha: result.snapshot.worktree.headSha,
  },
  branchPreparation: result.snapshot.worktree.branchPreparation,
}, null, 2));
