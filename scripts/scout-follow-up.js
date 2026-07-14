import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodexMcpRuntime } from "../src/adapters/codex-mcp.js";
import { TreehouseWorktreeManager } from "../src/adapters/treehouse.js";
import { TaskStore } from "../src/storage/task-store.js";
import { CodexScoutWorkflow } from "../src/workflows/codex-scout.js";
import { ScoutFollowUpWorkflow } from "../src/workflows/scout-follow-up.js";

const [command, ...args] = process.argv.slice(2);
const rootDir = path.resolve(
  process.env.SHIPMATES_STATE_DIR || path.join(process.cwd(), ".shipmates"),
);
const store = new TaskStore({ rootDir });
const actor = process.env.SHIPMATES_ACTOR || "firstmate";
const scoutWorkflow = new CodexScoutWorkflow({
  store,
  runtime: new CodexMcpRuntime(),
  worktreeManager: new TreehouseWorktreeManager(),
  schemaPath: fileURLToPath(
    new URL("../schemas/codex-worker-report.schema.json", import.meta.url),
  ),
  actor,
});
const workflow = new ScoutFollowUpWorkflow({ store, scoutWorkflow, actor });

let result;
switch (command) {
  case "run": {
    requireArguments(command, args, 6);
    const [
      taskId, synthesisId, followUpId, rawCheckIndex, workerId, replyId,
      ...unexpected
    ] = args;
    if (unexpected.length > 0) throw new Error("run accepts exactly 6 arguments");
    const humanActor = process.env.SHIPMATES_HUMAN_ACTOR;
    if (!humanActor) {
      throw new Error("SHIPMATES_HUMAN_ACTOR is required for follow-up selection");
    }
    result = await workflow.run({
      taskId,
      synthesisId,
      followUpId,
      checkIndex: parseIndex(rawCheckIndex),
      workerId,
      replyId,
      humanActor,
    });
    break;
  }
  case "reconcile": {
    requireArguments(command, args, 2);
    if (args.length !== 2) throw new Error("reconcile accepts exactly 2 arguments");
    result = await workflow.reconcile({ taskId: args[0], followUpId: args[1] });
    break;
  }
  default:
    throw new Error(
      "Usage: scout-follow-up.js <run TASK SYNTHESIS FOLLOW_UP CHECK_INDEX WORKER REPLY|reconcile TASK FOLLOW_UP>",
    );
}

console.log(JSON.stringify({
  taskId: result.snapshot.id,
  state: result.snapshot.state,
  reused: result.reused,
  followUp: result.followUp,
}, null, 2));

function requireArguments(name, values, count) {
  if (values.length < count || values.slice(0, count).some((value) => !value)) {
    throw new Error(`${name} requires ${count} arguments`);
  }
}

function parseIndex(value) {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("CHECK_INDEX must be a non-negative integer");
  }
  return Number(value);
}
