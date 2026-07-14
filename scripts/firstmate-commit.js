import path from "node:path";

import { ControlledGitCommitAdapter } from "../src/adapters/git-commit.js";
import { TaskStore } from "../src/storage/task-store.js";
import { FirstmateCommitWorkflow } from "../src/workflows/firstmate-commit.js";

const [command, taskId, ...rest] = process.argv.slice(2);
if (!new Set(["run", "reconcile"]).has(command) || !taskId || rest.length > 0) {
  throw new Error(
    "Usage: firstmate-commit.js <run|reconcile> <task-id>",
  );
}

const rootDir = path.resolve(process.env.SHIPMATES_STATE_DIR || ".shipmates");
const workflow = new FirstmateCommitWorkflow({
  store: new TaskStore({ rootDir }),
  commitAdapter: new ControlledGitCommitAdapter(),
  actor: process.env.SHIPMATES_ACTOR || "firstmate",
});
const result = command === "run"
  ? await workflow.run({ taskId })
  : await workflow.reconcile({ taskId });

console.log(JSON.stringify({
  taskId,
  reused: result.reused,
  state: result.snapshot.state,
  commit: result.commit,
}, null, 2));
