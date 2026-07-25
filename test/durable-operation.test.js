import assert from "node:assert/strict";
import test from "node:test";

import {
  DurableOperationError,
  DurableOperationProtocol,
} from "../src/operations/durable-operation.js";

test("records intent before action and an independently observed receipt", async () => {
  const { journal, events } = fixture();
  let external = null;
  const protocol = new DurableOperationProtocol({ journal, hook: (phase) => events.push(phase) });
  const result = await protocol.execute({
    operationId: "push-1", intent: { target: "origin/main", headSha: "abc" },
    observe: async () => ({ completed: external === "abc", evidence: { headSha: external } }),
    act: async () => { events.push("action"); external = "abc"; },
  });
  assert.equal(result.reused, false);
  assert.deepEqual(events, [
    "push-1:before_intent", "intent", "push-1:after_intent",
    "push-1:before_action", "attempt", "action", "push-1:after_action",
    "push-1:before_receipt", "receipt", "push-1:after_receipt",
  ]);
});

test("observes uncertain external completion before repeating the action", async () => {
  const { journal, records } = fixture();
  await journal.recordIntent("merge-1", { target: "pr-4", recordedAt: "earlier" });
  let actions = 0;
  const result = await new DurableOperationProtocol({ journal }).execute({
    operationId: "merge-1", intent: { target: "pr-4" },
    observe: async () => ({ completed: true, evidence: { mergeSha: "def" } }),
    act: async () => { actions += 1; },
  });
  assert.equal(actions, 0);
  assert.equal(records.get("merge-1").receipt.evidence.mergeSha, "def");
  assert.equal(result.reused, false);
});

test("returns an existing receipt without observing or acting again", async () => {
  const { journal } = fixture();
  await journal.recordIntent("delete-1", { target: "branch", recordedAt: "earlier" });
  await journal.recordReceipt("delete-1", { evidence: { absent: true } });
  let calls = 0;
  const result = await new DurableOperationProtocol({ journal }).execute({
    operationId: "delete-1", intent: { target: "branch" },
    observe: async () => { calls += 1; }, act: async () => { calls += 1; },
  });
  assert.equal(result.reused, true);
  assert.equal(calls, 0);
});

test("rejects changed intent even when a receipt exists", async () => {
  const { journal } = fixture();
  await journal.recordIntent("delete-1", { target: "branch", recordedAt: "earlier" });
  await journal.recordReceipt("delete-1", { evidence: { absent: true } });
  await assert.rejects(() => new DurableOperationProtocol({ journal }).execute({
    operationId: "delete-1", intent: { target: "other-branch" },
    observe: async () => ({ completed: true, evidence: { absent: true } }), act: async () => {},
  }), /cannot be reused with different intent/u);
});

test("persists intent before the initial observation", async () => {
  const { journal, events } = fixture();
  await new DurableOperationProtocol({ journal }).execute({
    operationId: "push-1", intent: { target: "origin/main" },
    observe: async () => {
      events.push("observe");
      return { completed: true, evidence: { headSha: "abc" } };
    },
    act: async () => {},
  });
  assert.equal(events.indexOf("intent") < events.indexOf("observe"), true);
});

test("rejects operation id reuse with different intent", async () => {
  const { journal } = fixture();
  await journal.recordIntent("push-1", { target: "origin/main", recordedAt: "earlier" });
  await assert.rejects(() => new DurableOperationProtocol({ journal }).execute({
    operationId: "push-1", intent: { target: "origin/release" },
    observe: async () => ({ completed: false }), act: async () => {},
  }), DurableOperationError);
});

test("fails closed when an action has no independent completion evidence", async () => {
  const { journal } = fixture();
  await assert.rejects(() => new DurableOperationProtocol({ journal }).execute({
    operationId: "opaque-1", intent: { target: "remote" },
    observe: async () => ({ completed: false }), act: async () => {},
  }), /not independently observable/u);
});

test("rejects completed observations without evidence", async () => {
  const { journal } = fixture();
  await assert.rejects(() => new DurableOperationProtocol({ journal }).execute({
    operationId: "opaque-1", intent: { target: "remote" },
    observe: async () => ({ completed: true }), act: async () => {},
  }), /must contain evidence/u);
});

function fixture() {
  const records = new Map();
  const events = [];
  const mutate = async (id, transform, event) => {
    const current = records.get(id) || { operationId: id, intent: null, attempts: [], receipt: null };
    const next = transform(current);
    records.set(id, next);
    if (event) events.push(event);
    return next;
  };
  const journal = {
    read: async (id) => records.get(id) || null,
    recordIntent: (id, intent) => mutate(id, (value) => ({ ...value, intent }), "intent"),
    recordAttempt: (id, attempt) => mutate(id, (value) => ({
      ...value, attempts: [...value.attempts, attempt],
    }), "attempt"),
    recordReceipt: (id, receipt) => mutate(id, (value) => ({ ...value, receipt }), "receipt"),
  };
  return { journal, records, events };
}
