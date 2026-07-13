import path from "node:path";

import { NoMistakesLocalGate } from "../src/adapters/no-mistakes.js";
import { TaskStore } from "../src/storage/task-store.js";

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
const report = await new NoMistakesLocalGate({
  binaryPath,
  stateRoot: path.join(rootDir, "no-mistakes"),
}).run({
  taskId,
  worktreePath,
  expectedHeadSha,
  intent: intentParts.join(" "),
});
const snapshot = await store.recordLocalValidation({
  taskId,
  actor: process.env.SHIPMATES_ACTOR || "firstmate",
  report,
  eventId: `${taskId}:validation:${report.runId}:v1`,
  at: report.completedAt,
});
console.log(JSON.stringify(snapshot, null, 2));
