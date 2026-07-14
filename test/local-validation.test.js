import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalValidationWorkflow,
  LocalValidationWorkflowError,
  LocalValidationRecoveryRequiredError,
} from "../src/workflows/local-validation.js";

test("records local validation for the exact active lease", async () => {
  const report = validationReport();
  const store = new MemoryStore();
  const calls = [];
  const gate = {
    pinEvidence() {
      return pinEvidence();
    },
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
  assert.equal(store.records.length, 2);
  const reused = await workflow.run({
    taskId: "validation-001",
    intent: "Validate the practice change locally",
  });
  assert.equal(reused.reused, true);
  assert.equal(calls.length, 1);
  await assert.rejects(
    workflow.run({ taskId: "validation-001", intent: "Different intent" }),
    /bound to different intent/u,
  );
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

test("does not repeat a validator after durable intent without a result", async () => {
  const store = new MemoryStore();
  let runs = 0;
  const workflow = new LocalValidationWorkflow({
    store,
    gate: {
      pinEvidence,
      async run() {
        runs += 1;
        throw new Error("validator result lost");
      },
    },
  });

  await assert.rejects(
    workflow.run({ taskId: "validation-001", intent: "Validate locally" }),
    /validator result lost/u,
  );
  await assert.rejects(
    workflow.run({ taskId: "validation-001", intent: "Validate locally" }),
    LocalValidationRecoveryRequiredError,
  );
  assert.equal(runs, 1);
});

test("explicitly reconciles one exact durable validation request", async () => {
  const store = new MemoryStore();
  const intent = "Validate locally";
  let loseResult = true;
  let runs = 0;
  const workflow = new LocalValidationWorkflow({
    store,
    gate: {
      pinEvidence,
      async run() {
        runs += 1;
        if (loseResult) throw new Error("validator result lost");
        return validationReport();
      },
    },
  });
  await assert.rejects(
    workflow.run({ taskId: "validation-001", intent }),
    /validator result lost/u,
  );
  loseResult = false;
  const result = await workflow.reconcile({ taskId: "validation-001", intent });
  assert.equal(result.report.runId, "run-local-1");
  assert.equal(runs, 2);
});

class MemoryStore {
  constructor() {
    this.records = [];
    this.snapshot = {
      state: "validating",
      validationRequests: [],
      validationRuns: [],
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
    this.snapshot.validationRequests[0].status = "completed";
    this.snapshot = { ...this.snapshot, validationRuns: [record.report] };
    return this.snapshot;
  }

  async requestLocalValidation(record) {
    this.records.push(record);
    const request = {
      ...record.request,
      status: "requested",
      requestEventId: record.eventId,
    };
    this.snapshot = { ...this.snapshot, validationRequests: [request] };
    return this.snapshot;
  }
}

function validationReport() {
  return {
    runId: "run-local-1",
    completedAt: "2026-07-13T19:00:00.000Z",
  };
}

function pinEvidence() {
  return {
    name: "no-mistakes",
    pinned: true,
    version: "v1.37.0",
    sourceCommit: "a".repeat(40),
    binarySha256: "b".repeat(64),
  };
}
