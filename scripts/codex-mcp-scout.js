import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodexMcpRuntime } from "../src/adapters/codex-mcp.js";
import { TreehouseWorktreeManager } from "../src/adapters/treehouse.js";
import { TaskStore } from "../src/storage/task-store.js";
import { CodexScoutWorkflow } from "../src/workflows/codex-scout.js";

const [command, ...args] = process.argv.slice(2);
const rootDir = path.resolve(
  process.env.SHIPMATES_STATE_DIR || path.join(process.cwd(), ".shipmates"),
);
const workflow = new CodexScoutWorkflow({
  store: new TaskStore({ rootDir }),
  runtime: new CodexMcpRuntime(),
  worktreeManager: new TreehouseWorktreeManager(),
  schemaPath: fileURLToPath(
    new URL("../schemas/codex-worker-report.schema.json", import.meta.url),
  ),
  actor: process.env.SHIPMATES_ACTOR || "firstmate",
});

let snapshot;
switch (command) {
  case "run": {
    requireArguments(command, args, 3);
    const [taskId, workerId, ...briefParts] = args;
    snapshot = await workflow.run({
      taskId,
      workerId,
      brief: briefParts.join(" "),
    });
    break;
  }
  case "reconcile": {
    requireArguments(command, args, 2);
    const [taskId, workerId] = args;
    snapshot = await workflow.reconcile({ taskId, workerId });
    break;
  }
  case "reply": {
    requireArguments(command, args, 4);
    const [taskId, workerId, replyId, ...promptParts] = args;
    snapshot = await workflow.reply({
      taskId,
      workerId,
      replyId,
      prompt: promptParts.join(" "),
    });
    break;
  }
  case "reconcile-reply": {
    requireArguments(command, args, 3);
    const [taskId, workerId, replyId] = args;
    snapshot = await workflow.reconcileReply({ taskId, workerId, replyId });
    break;
  }
  default:
    throw new Error(
      "Usage: codex-mcp-scout.js <run|reconcile|reply|reconcile-reply> ...",
    );
}

console.log(JSON.stringify(snapshot, null, 2));

function requireArguments(name, values, minimum) {
  if (values.length < minimum || values.slice(0, minimum).some((value) => !value)) {
    throw new Error(`${name} requires at least ${minimum} arguments`);
  }
}
