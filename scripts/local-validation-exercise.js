import path from "node:path";

import { NoMistakesLocalGate } from "../src/adapters/no-mistakes.js";
import { TaskStore } from "../src/storage/task-store.js";
import { LocalValidationWorkflow } from "../src/workflows/local-validation.js";

const [taskId, worktreePath, expectedHeadSha, ...intentParts] =
  process.argv.slice(2);
if (!taskId || !worktreePath || !expectedHeadSha || intentParts.length === 0) {
  throw new Error(
    "Usage: local-validation-exercise.js <task-id> <worktree> <head-sha> <intent>",
  );
}
const binaryPath = process.env.NO_MISTAKES_BIN;
if (!binaryPath) throw new Error("NO_MISTAKES_BIN is required");
const rootDir = path.resolve(process.env.SHIPMATES_STATE_DIR || ".shipmates");
const store = new TaskStore({ rootDir });
const snapshot = await store.getSnapshot(taskId);
if (snapshot.worktree?.worktreePath !== path.resolve(worktreePath) ||
  snapshot.worktree?.headSha !== expectedHeadSha) {
  throw new Error("Supplied exercise worktree and head do not match the task ledger");
}
const result = await new LocalValidationWorkflow({
  store,
  gate: new NoMistakesLocalGate({
    binaryPath,
    stateRoot: path.join(rootDir, "no-mistakes"),
  }),
  actor: process.env.SHIPMATES_ACTOR || "firstmate",
}).run({
  taskId,
  intent: intentParts.join(" "),
});
/*
 * The exercise retains explicit worktree/head arguments as an operator
 * cross-check, while the workflow uses only the authoritative ledger values.
 */
console.log(JSON.stringify(result, null, 2));
