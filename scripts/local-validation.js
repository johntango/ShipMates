import path from "node:path";

import {
  FAST_LOCAL_SKIP_STEPS,
  NoMistakesLocalGate,
} from "../src/adapters/no-mistakes.js";
import { TaskStore } from "../src/storage/task-store.js";
import { LocalValidationWorkflow } from "../src/workflows/local-validation.js";

const [command, ...args] = process.argv.slice(2);
if (!new Set(["run", "reconcile"]).has(command) || args.length < 2) {
  throw new Error("Usage: local-validation.js <run|reconcile> <task-id> <intent>");
}
const binaryPath = process.env.NO_MISTAKES_BIN;
if (!binaryPath) {
  throw new Error("NO_MISTAKES_BIN must point to the pinned no-mistakes executable");
}
const rootDir = path.resolve(process.env.SHIPMATES_STATE_DIR || ".shipmates");
const workflow = new LocalValidationWorkflow({
  store: new TaskStore({ rootDir }),
  gate: new NoMistakesLocalGate({
    binaryPath,
    stateRoot: path.join(rootDir, "no-mistakes"),
    onProgress: (message) => console.error(`[no-mistakes] ${message}`),
    ...(process.env.SHIPMATES_VALIDATION_PROFILE === "fast"
      ? { skipSteps: FAST_LOCAL_SKIP_STEPS }
      : {}),
  }),
  actor: process.env.SHIPMATES_ACTOR || "firstmate",
});
const [taskId, ...intentParts] = args;
const snapshot = await workflow[command]({
  taskId,
  intent: intentParts.join(" "),
});
console.log(JSON.stringify(snapshot, null, 2));
