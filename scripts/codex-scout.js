import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodexWorkerRuntime } from "../src/adapters/codex-worker.js";
import { TreehouseWorktreeManager } from "../src/adapters/treehouse.js";
import { TaskStore } from "../src/storage/task-store.js";
import { CodexScoutWorkflow } from "../src/workflows/codex-scout.js";

const [command, ...args] = process.argv.slice(2);
const rootDir = path.resolve(
  process.env.SHIPMATES_STATE_DIR || path.join(process.cwd(), ".shipmates"),
);
const schemaPath = fileURLToPath(
  new URL("../schemas/codex-worker-report.schema.json", import.meta.url),
);
const workflow = new CodexScoutWorkflow({
  store: new TaskStore({ rootDir }),
  runtime: new CodexWorkerRuntime(),
  worktreeManager: new TreehouseWorktreeManager(),
  schemaPath,
  actor: process.env.SHIPMATES_ACTOR || "firstmate",
});

let snapshot;
switch (command) {
  case "run": {
    requireArguments(command, args, 3);
    const [taskId, workerId, brief] = args;
    snapshot = await workflow.run({ taskId, workerId, brief });
    break;
  }
  case "reconcile": {
    requireArguments(command, args, 2);
    const [taskId, workerId] = args;
    snapshot = await workflow.reconcile({ taskId, workerId });
    break;
  }
  default:
    throw new Error("Usage: codex-scout.js <run|reconcile> ...");
}

console.log(JSON.stringify(snapshot, null, 2));

function requireArguments(name, values, minimum) {
  if (values.length < minimum || values.slice(0, minimum).some((value) => !value)) {
    throw new Error(`${name} requires at least ${minimum} arguments`);
  }
}
