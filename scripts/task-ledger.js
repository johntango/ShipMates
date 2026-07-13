import path from "node:path";

import { TaskStore } from "../src/storage/task-store.js";

const [command, ...args] = process.argv.slice(2);
const rootDir = path.resolve(
  process.env.SHIPMATES_STATE_DIR || path.join(process.cwd(), ".shipmates"),
);
const actor = process.env.SHIPMATES_ACTOR || "firstmate";
const store = new TaskStore({ rootDir });

let result;

switch (command) {
  case "create": {
    const [taskId, kind, repo, baseSha] = args;
    requireArguments(command, args, 4);
    result = await store.createTask({ taskId, kind, repo, baseSha, actor });
    break;
  }

  case "transition": {
    const [taskId, from, to, reason] = args;
    requireArguments(command, args, 3);
    result = await store.transition({
      taskId,
      from,
      to,
      reason,
      actor,
    });
    break;
  }

  case "evidence": {
    const [taskId, kind, value] = args;
    requireArguments(command, args, 3);
    result = await store.recordEvidence({
      taskId,
      kind,
      value,
      actor,
    });
    break;
  }

  case "approve-merge": {
    const [taskId, repo, prNumber, headSha, mergeMethod] = args;
    requireArguments(command, args, 5);
    result = await store.recordApproval({
      taskId,
      repo,
      prNumber: parsePositiveInteger("prNumber", prNumber),
      headSha,
      mergeMethod,
      decision: "approved",
      actor,
    });
    break;
  }

  case "show": {
    const [taskId] = args;
    requireArguments(command, args, 1);
    result = await store.getSnapshot(taskId);
    break;
  }

  case "events": {
    const [taskId] = args;
    requireArguments(command, args, 1);
    result = await store.readEvents(taskId);
    break;
  }

  case "rebuild": {
    const [taskId] = args;
    requireArguments(command, args, 1);
    result = await store.rebuildSnapshot(taskId);
    break;
  }

  default:
    throw new Error(
      "Usage: task-ledger.js <create|transition|evidence|approve-merge|show|events|rebuild> ...",
    );
}

console.log(JSON.stringify(result, null, 2));

function requireArguments(name, values, minimum) {
  if (values.length < minimum || values.slice(0, minimum).some((value) => !value)) {
    throw new Error(`${name} requires at least ${minimum} arguments`);
  }
}

function parsePositiveInteger(label, value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return parsed;
}
