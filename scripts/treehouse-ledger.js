import path from "node:path";

import { TreehouseWorktreeManager } from "../src/adapters/treehouse.js";
import { TaskStore } from "../src/storage/task-store.js";
import { TreehouseLedgerWorkflow } from "../src/workflows/treehouse-ledger.js";

const [command, ...args] = process.argv.slice(2);
const store = new TaskStore({
  rootDir: path.resolve(
    process.env.SHIPMATES_STATE_DIR || path.join(process.cwd(), ".shipmates"),
  ),
});
const workflow = new TreehouseLedgerWorkflow({
  store,
  manager: new TreehouseWorktreeManager(),
  actor: process.env.SHIPMATES_ACTOR || "firstmate",
});

let snapshot;
switch (command) {
  case "acquire": {
    requireArguments(command, args, 2);
    const [taskId, repoPath] = args;
    snapshot = await workflow.acquire({
      taskId,
      repoPath: path.resolve(repoPath),
    });
    break;
  }
  case "reconcile-acquire": {
    requireArguments(command, args, 3);
    const [taskId, repoPath, worktreePath] = args;
    snapshot = await workflow.reconcileAcquisition({
      taskId,
      repoPath: path.resolve(repoPath),
      worktreePath: path.resolve(worktreePath),
    });
    break;
  }
  case "complete-no-mutation": {
    requireArguments(command, args, 1);
    snapshot = await workflow.completeNoMutation({ taskId: args[0] });
    break;
  }
  case "reconcile-return": {
    requireArguments(command, args, 1);
    snapshot = await workflow.reconcileReturn({ taskId: args[0] });
    break;
  }
  default:
    throw new Error(
      "Usage: treehouse-ledger.js <acquire|reconcile-acquire|complete-no-mutation|reconcile-return> ...",
    );
}

console.log(JSON.stringify(snapshot, null, 2));

function requireArguments(name, values, minimum) {
  if (values.length < minimum || values.slice(0, minimum).some((value) => !value)) {
    throw new Error(`${name} requires at least ${minimum} arguments`);
  }
}
