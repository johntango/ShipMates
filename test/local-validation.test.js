import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalValidationSetupBlockedError,
  LocalValidationWorkflow,
  LocalValidationWorkflowError,
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
      await input.onProgress("Running tests");
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
  assert.deepEqual(store.evidence.map(({ kind }) => kind), ["task-progress"]);
  assert.match(store.evidence[0].value, /Running tests/u);
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
    LocalValidationSetupBlockedError,
  );
  assert.equal(store.snapshot.state, "blocked");
  assert.equal(store.evidence.some(({ kind }) => kind === "validation-setup-failure"), true);
  await assert.rejects(
    workflow.run({ taskId: "validation-001", intent: "Validate locally" }),
    LocalValidationWorkflowError,
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
    LocalValidationSetupBlockedError,
  );
  loseResult = false;
  const result = await workflow.reconcile({ taskId: "validation-001", intent });
  assert.equal(result.report.runId, "run-local-1");
  assert.equal(runs, 2);
  assert.deepEqual(store.transitions.map(({ from, to }) => [from, to]), [
    ["validating", "blocked"],
    ["blocked", "running"],
    ["running", "validating"],
  ]);
});

test("moves an approval-gated validation to awaiting human", async () => {
  const store = new MemoryStore();
  const report = {
    ...validationReport(),
    gate: { step: "review", status: "awaiting_approval" },
  };
  const workflow = new LocalValidationWorkflow({
    store,
    gate: { pinEvidence, async run() { return report; } },
  });

  const result = await workflow.run({
    taskId: "validation-001",
    intent: "Validate locally",
  });

  assert.equal(result.snapshot.state, "awaiting_human");
  assert.equal(store.transitions[0].from, "validating");
  assert.equal(store.transitions[0].to, "awaiting_human");
});

test("approves and reconciles the exact existing validation gate", async () => {
  const store = new MemoryStore();
  const intent = "Validate locally";
  const gated = {
    ...validationReport(),
    intentSha256: "unused",
    gate: { step: "test", status: "awaiting_approval" },
  };
  const workflow = new LocalValidationWorkflow({
    store,
    gate: {
      pinEvidence,
      async run() { return gated; },
      async respond() { return { ...gated, gate: null, passed: true }; },
    },
  });
  await workflow.run({ taskId: "validation-001", intent });
  store.snapshot.validationRuns[0].intentSha256 =
    store.snapshot.validationRequests[0].intentSha256;
  const result = await workflow.approve({ taskId: "validation-001", intent });
  assert.equal(result.report.passed, true);
  assert.equal(result.snapshot.state, "ready_to_merge");
  assert.equal(store.reconciliations.length, 1);
});

test("finishes approval after terminal reconciliation was already recorded", async () => {
  const store = new MemoryStore();
  const intent = "Validate locally";
  const gated = {
    ...validationReport(),
    intentSha256: "unused",
    gate: { step: "test", status: "awaiting_approval" },
  };
  let responses = 0;
  const workflow = new LocalValidationWorkflow({
    store,
    gate: {
      pinEvidence,
      async run() { return gated; },
      async respond() {
        responses += 1;
        return { ...gated, gate: null, passed: true };
      },
    },
  });
  await workflow.run({ taskId: "validation-001", intent });
  store.snapshot.validationRuns[0].intentSha256 =
    store.snapshot.validationRequests[0].intentSha256;
  const terminal = { ...store.snapshot.validationRuns[0], gate: null, passed: true };
  await store.reconcileLocalValidation({
    report: terminal,
    runId: terminal.runId,
    eventId: "reconciled",
  });

  const result = await workflow.approve({ taskId: "validation-001", intent });

  assert.equal(result.reused, true);
  assert.equal(result.snapshot.state, "ready_to_merge");
  assert.equal(responses, 0);
});

class MemoryStore {
  constructor() {
    this.records = [];
    this.evidence = [];
    this.transitions = [];
    this.reconciliations = [];
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
    this.snapshot.validationRequests[0].runId = record.report.runId;
    this.snapshot = { ...this.snapshot, validationRuns: [record.report] };
    return this.snapshot;
  }

  async recordEvidence(record) {
    this.evidence.push(record);
    return this.snapshot;
  }

  async reconcileLocalValidation(record) {
    this.reconciliations.push(record);
    this.snapshot.validationRuns[0] = {
      ...record.report,
      eventId: record.eventId,
    };
    this.snapshot.validationRequests[0].passed = true;
    this.snapshot.validationRequests[0].reconciledEventId = record.eventId;
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

  async transition(input) {
    this.transitions.push(input);
    this.snapshot = { ...this.snapshot, state: input.to };
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
    version: "v1.41.1",
    sourceCommit: "a".repeat(40),
    binarySha256: "b".repeat(64),
  };
}
