import path from "node:path";

import { TaskStore } from "../src/storage/task-store.js";
import { ScoutSynthesisWorkflow } from "../src/workflows/scout-synthesis.js";

const [command, taskId, synthesisId, firstWorkerId, secondWorkerId] =
  process.argv.slice(2);
if (command !== "run" || !taskId || !synthesisId || !firstWorkerId ||
  !secondWorkerId || process.argv.length !== 7) {
  throw new Error(
    "Usage: scout-synthesis.js run TASK SYNTHESIS_ID WORKER_A WORKER_B",
  );
}

const store = new TaskStore({
  rootDir: path.resolve(process.env.SHIPMATES_STATE_DIR || ".shipmates"),
});
const workflow = new ScoutSynthesisWorkflow({
  store,
  actor: process.env.SHIPMATES_ACTOR || "firstmate",
});
const result = await workflow.run({
  taskId,
  synthesisId,
  workerIds: [firstWorkerId, secondWorkerId],
});
const record = result.snapshot.scoutSyntheses.find(({ synthesisId: id }) =>
  id === synthesisId);
console.log(JSON.stringify({
  taskId,
  synthesisId,
  state: result.snapshot.state,
  reused: result.reused,
  eventId: record.eventId,
  artifactPath: record.artifactPath,
  artifactSha256: record.artifactSha256,
  outcome: record.outcome,
  counts: record.counts,
}, null, 2));
