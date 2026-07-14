import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodexWorkerRuntime } from "../src/adapters/codex-worker.js";
import { TreehouseWorktreeManager } from "../src/adapters/treehouse.js";
import { TaskStore } from "../src/storage/task-store.js";
import { CodexShipWorkflow } from "../src/workflows/codex-ship.js";

const [command, taskId, workerId = "implementer", ...briefParts] =
  process.argv.slice(2);
if (!new Set(["run", "reconcile"]).has(command) || !taskId || !workerId ||
  (command === "run" && briefParts.length === 0) ||
  (command === "reconcile" && briefParts.length > 0)) {
  throw new Error(
    "Usage: codex-ship.js <run TASK WORKER BRIEF...|reconcile TASK [WORKER]>",
  );
}

const store = new TaskStore({
  rootDir: path.resolve(process.env.SHIPMATES_STATE_DIR || ".shipmates"),
});
const workflow = new CodexShipWorkflow({
  store,
  runtime: new CodexWorkerRuntime(),
  worktreeManager: new TreehouseWorktreeManager(),
  schemaPath: fileURLToPath(
    new URL("../schemas/codex-worker-report.schema.json", import.meta.url),
  ),
  actor: process.env.SHIPMATES_ACTOR || "firstmate",
});
const result = command === "run"
  ? await workflow.run({ taskId, workerId, brief: briefParts.join(" ") })
  : await workflow.reconcile({ taskId, workerId });

console.log(JSON.stringify({
  taskId,
  state: result.snapshot.state,
  reused: result.reused,
  worker: {
    id: result.worker.id,
    status: result.worker.status,
    threadId: result.worker.threadId,
    report: result.worker.report,
    verification: result.worker.verification,
  },
}, null, 2));
