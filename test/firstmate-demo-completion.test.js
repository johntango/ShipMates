import assert from "node:assert/strict";
import test from "node:test";

import { completeFirstmateDemoTask, hasDemoEvidence } from "../src/workflows/firstmate-demo-completion.js";

test("completes a committed validating task with explicit local-only demo evidence", async () => {
  const taskId = "task-demo-completion";
  let snapshot = {
    id: taskId, state: "validating", evidence: [],
    gitCommits: [{ status: "completed", result: { headSha: "abc123" } }],
  };
  const calls = [];
  const store = {
    async getSnapshot() { return snapshot; },
    async recordEvidence(input) {
      calls.push(["evidence", input]);
      snapshot = { ...snapshot, evidence: [...snapshot.evidence, { kind: input.kind, value: input.value }] };
      return snapshot;
    },
    async transition(input) {
      calls.push(["transition", input]);
      assert.equal(snapshot.state, input.from);
      snapshot = { ...snapshot, state: input.to };
      return snapshot;
    },
  };

  const result = await completeFirstmateDemoTask({ store, taskId });
  assert.equal(result.snapshot.state, "complete");
  assert.equal(result.commit.headSha, "abc123");
  assert.equal(hasDemoEvidence(result.snapshot), true);
  assert.deepEqual(calls.map(([kind]) => kind), ["evidence", "transition", "transition"]);
  assert.match(calls[0][1].value, /"remoteOperations":false/u);
});

test("completes verified no-change demo work without manufacturing a commit", async () => {
  const taskId = "task-demo-no-change";
  let snapshot = {
    id: taskId, state: "running", baseSha: "abc123", evidence: [], gitCommits: [],
    workers: [{ id: "implementer", status: "reported", report: { status: "completed" },
      verification: { noMutation: true } }],
  };
  const store = {
    async getSnapshot() { return snapshot; },
    async recordEvidence(input) {
      snapshot = { ...snapshot, evidence: [...snapshot.evidence, { kind: input.kind, value: input.value }] };
      return snapshot;
    },
    async transition(input) {
      assert.equal(snapshot.state, input.from);
      snapshot = { ...snapshot, state: input.to };
      return snapshot;
    },
  };

  const result = await completeFirstmateDemoTask({ store, taskId });
  assert.equal(result.snapshot.state, "complete");
  assert.equal(result.commit, null);
  assert.match(result.snapshot.evidence[0].value, /"noChanges":true/u);
});
