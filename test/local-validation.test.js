import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalValidationWorkflow,
  LocalValidationWorkflowError,
} from "../src/workflows/local-validation.js";

test("records local validation for the exact active lease", async () => {
  const report = validationReport();
  const store = new MemoryStore();
  const calls = [];
  const gate = {
    async run(input) {
      calls.push(input);
      return report;
    },
  };
  const workflow = new LocalValidationWorkflow({ store, gate });

  const result = await workflow.run({
    taskId: "validation-001",
    intent: "Validate the practice change locally",
  });

  assert.equal(calls[0].expectedHeadSha, "a".repeat(40));
  assert.equal(calls[0].worktreePath, "/tmp/leased-worktree");
  assert.equal(result.report.runId, "run-local-1");
  assert.equal(store.records.length, 1);
});

test("refuses validation without a validating active lease", async () => {
  const store = new MemoryStore();
  store.snapshot.state = "running";
  const workflow = new LocalValidationWorkflow({
    store,
    gate: { run: async () => validationReport() },
  });

  await assert.rejects(
    workflow.run({ taskId: "validation-001", intent: "Validate locally" }),
    LocalValidationWorkflowError,
  );
  assert.equal(store.records.length, 0);
});

class MemoryStore {
  constructor() {
    this.records = [];
    this.snapshot = {
      state: "validating",
      worktree: {
        status: "leased",
        worktreePath: "/tmp/leased-worktree",
        headSha: "a".repeat(40),
      },
    };
  }

  async getSnapshot() {
    return this.snapshot;
  }

  async recordLocalValidation(record) {
    this.records.push(record);
    return { report: record.report };
  }
}

function validationReport() {
  return {
    runId: "run-local-1",
    completedAt: "2026-07-13T19:00:00.000Z",
  };
}
