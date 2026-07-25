import assert from "node:assert/strict";
import test from "node:test";

import {
  createSupervisorTask,
  DurableSupervisor,
} from "../src/supervisor/durable-supervisor.js";

test("owns startup reconciliation, observation, advancement, and projection", async () => {
  const calls = [];
  const scheduler = schedulerFixture(calls);
  const supervisor = new DurableSupervisor({
    observe: async () => { calls.push("observe"); return ["worker-running"]; },
    reconcile: async ({ trigger }) => { calls.push(`reconcile:${trigger}`); return ["no_action"]; },
    advance: async () => { calls.push("advance"); return []; },
    project: async () => { calls.push("project"); return { revision: calls.length }; },
    scheduler,
  });
  const result = await supervisor.start();
  assert.equal(result.revision > 0, true);
  assert.deepEqual(calls.slice(0, 5), [
    "observe", "reconcile:startup", "advance", "project", "scheduler:start",
  ]);
  await supervisor.stop();
  assert.equal(calls.at(-1), "scheduler:cancel");
});

test("serializes overlapping runs and advances once", async () => {
  let release;
  let runs = 0;
  const supervisor = new DurableSupervisor({
    observe: () => new Promise((resolve) => { release = resolve; }),
    reconcile: async () => { runs += 1; return []; },
    advance: async () => [], project: async () => ({}), scheduler: schedulerFixture([]),
  });
  const first = supervisor.runOnce();
  const second = supervisor.runOnce();
  release([]);
  assert.equal(await first, await second);
  assert.equal(runs, 1);
});

test("treats conversational panes as reconnectable projection clients", async () => {
  let revision = 1;
  const received = [];
  const supervisor = new DurableSupervisor({
    observe: async () => [], reconcile: async () => [], advance: async () => [],
    project: async () => ({ revision: revision++ }), scheduler: schedulerFixture([]),
  });
  const disconnect = await supervisor.connect({ send: async (snapshot) => received.push(snapshot) });
  await supervisor.runOnce("command");
  disconnect();
  await supervisor.runOnce("scheduled");
  assert.deepEqual(received.map(({ revision: value }) => value), [1, 2]);
});

test("creates a scheduler callback that never owns conversational state", async () => {
  const triggers = [];
  const task = createSupervisorTask({ runOnce: async (trigger) => triggers.push(trigger) });
  await task();
  assert.deepEqual(triggers, ["scheduled"]);
});

test("does not restart scheduling when stop races startup", async () => {
  let release;
  const calls = [];
  const supervisor = new DurableSupervisor({
    observe: () => new Promise((resolve) => { release = resolve; }),
    reconcile: async () => [], advance: async () => [], project: async () => ({}),
    scheduler: schedulerFixture(calls),
  });
  const starting = supervisor.start();
  const stopping = supervisor.stop();
  release([]);
  await Promise.all([starting, stopping]);
  assert.equal(calls.includes("scheduler:start"), false);
  assert.equal(calls.filter((call) => call === "scheduler:cancel").length, 2);
});

test("contains initial projection client failures", async () => {
  const supervisor = new DurableSupervisor({
    observe: async () => [], reconcile: async () => [], advance: async () => [],
    project: async () => ({}), scheduler: schedulerFixture([]),
  });
  const disconnect = await supervisor.connect({ send: async () => { throw new Error("offline"); } });
  disconnect();
});

function schedulerFixture(calls) {
  return {
    start() { calls.push("scheduler:start"); },
    async cancel() { calls.push("scheduler:cancel"); },
  };
}
