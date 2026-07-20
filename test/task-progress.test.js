import assert from "node:assert/strict";
import test from "node:test";

import { TaskProgressRecorder } from "../src/workflows/task-progress.js";

test("records one bounded subsystem-neutral progress event", async () => {
  const records = [];
  const recorder = new TaskProgressRecorder({
    store: { recordEvidence: async (record) => records.push(record) },
    taskId: "task-one",
    idFactory: () => "event-one",
  });
  const progress = await recorder.record({
    phase: "validation", step: "test", message: `Running\u0000 ${"x".repeat(300)}`,
  });
  assert.equal(progress.phase, "validation");
  assert.equal(progress.step, "test");
  assert.equal(progress.status, "running");
  assert.equal(progress.message.length, 240);
  assert.equal(records[0].kind, "task-progress");
  assert.equal(records[0].eventId, "task-one:progress:event-one");
});
