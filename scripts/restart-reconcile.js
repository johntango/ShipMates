import path from "node:path";

import { GitHubReadGateway } from "../src/adapters/github-read.js";
import { TreehouseWorktreeManager } from "../src/adapters/treehouse.js";
import { TaskStore } from "../src/storage/task-store.js";
import { RestartReconciler } from "../src/workflows/restart-reconciliation.js";

const [taskId, auditId] = process.argv.slice(2);
if (!taskId || !auditId) {
  throw new Error("Usage: restart-reconcile.js <task-id> <audit-id>");
}
const rootDir = path.resolve(process.env.SHIPMATES_STATE_DIR || ".shipmates");
const snapshot = await new RestartReconciler({
  store: new TaskStore({ rootDir }),
  treehouseManager: new TreehouseWorktreeManager(),
  githubGateway: new GitHubReadGateway(),
  actor: process.env.SHIPMATES_ACTOR || "firstmate",
}).audit({ taskId, auditId });

console.log(JSON.stringify(snapshot, null, 2));
