import assert from "node:assert/strict";
import test from "node:test";

import { FirstmateWatchdog } from "../src/monitoring/firstmate-watchdog.js";

test("refers an overdue live worker to a named project and human", async () => {
  const watchdog = fixture({
    state: "awaiting_worker",
    workers: [{ id: "implementer", status: "started" }],
  }, { live: true });
  const [alert] = await watchdog.inspect();
  assert.equal(alert.projectName, "BallsB");
  assert.equal(alert.taskName, "Add interactions");
  assert.equal(alert.category, "overdue_process");
  assert.match(alert.remedy, /human decision/u);
  assert.equal(alert.ageMinutes, 20);
});

test("recognizes completed terminal evidence and forbids a duplicate", async () => {
  const watchdog = fixture({
    state: "awaiting_worker",
    workers: [{ id: "implementer", status: "started" }],
  }, { terminal: { status: "completed" } });
  const [alert] = await watchdog.inspect();
  assert.equal(alert.category, "reconciliation_required");
  assert.match(alert.status, /completed but/u);
  assert.match(alert.remedy, /must not launch a duplicate/u);
});

test("durably blocks a stale task with no live runner or terminal artifact", async () => {
  const updates = [];
  const watchdog = fixture({
    state: "awaiting_worker",
    workers: [{ id: "implementer", status: "started" }],
  }, { updates });
  const [result] = await watchdog.terminalizeStale();
  assert.equal(result.projectId, "project-b");
  assert.equal(result.planTaskId, "interactions");
  assert.equal(updates[0].status, "blocked");
  assert.match(updates[0].blockingReason, /Last durable activity/u);
  assert.match(updates[0].blockingReason, /reconciled before retrying/u);
});

test("does not block a live task or a completed artifact awaiting reconciliation", async () => {
  const liveUpdates = [];
  assert.deepEqual(await fixture({
    state: "awaiting_worker", workers: [{ id: "implementer", status: "started" }],
  }, { live: true, updates: liveUpdates }).terminalizeStale(), []);
  assert.deepEqual(liveUpdates, []);

  const completedUpdates = [];
  assert.deepEqual(await fixture({
    state: "awaiting_worker", workers: [{ id: "implementer", status: "started" }],
  }, { terminal: { status: "completed" }, updates: completedUpdates }).terminalizeStale(), []);
  assert.deepEqual(completedUpdates, []);
});

test("distinguishes a validation approval from a running process", async () => {
  const watchdog = fixture({
    state: "validating", workers: [], validationRequests: [{ status: "completed" }],
    validationRuns: [{ gate: { step: "test", status: "awaiting_approval" } }],
  });
  const [alert] = await watchdog.inspect();
  assert.equal(alert.category, "approval_required");
  assert.match(alert.remedy, /approve or reject/u);
});

test("does not alert before the configured limit or for terminal tasks", async () => {
  assert.deepEqual(await fixture({ state: "running", workers: [] }, {
    lastEventAt: "2026-07-15T11:50:00.001Z",
  }).inspect(), []);
  assert.deepEqual(await fixture({ state: "awaiting_human", workers: [] }).inspect(), []);
  assert.deepEqual(await fixture({ state: "running", workers: [] }).inspect(), []);
});

test("separates day-old ledger state from live process alerts", async () => {
  const watchdog = fixture({ state: "running", workers: [] }, {
    lastEventAt: "2026-07-14T11:00:00.000Z",
  });
  assert.deepEqual(await watchdog.inspect(), []);
  const [historical] = await watchdog.inspectHistorical();
  assert.equal(historical.state, "running");
  assert.match(historical.remedy, /without treating it as a live process/u);
});

test("monitors persistent Project Agent runs outside the Treehouse task ledger", async () => {
  const record = JSON.stringify({ status: "started", startedAt: "2026-07-15T11:40:00.000Z" });
  const watchdog = new FirstmateWatchdog({
    store: { rootDir: "/state", listTaskIds: async () => [], getSnapshot: async () => null },
    projectStore: { list: async () => [{
      id: "project-a", name: "BallsA", executionPolicy: { mode: "persistent_project" },
      tasks: [{ id: "interface", taskId: "task-interface", title: "Build interface", status: "dispatched" }],
    }] },
    clock: () => new Date("2026-07-15T12:00:00.000Z"),
    isLiveTask: () => true,
    read: async (target) => {
      if (target.endsWith("interface.json")) return record;
      const error = new Error("missing"); error.code = "ENOENT"; throw error;
    },
  });
  const [alert] = await watchdog.inspect();
  assert.equal(alert.projectName, "BallsA");
  assert.equal(alert.category, "overdue_process");
  assert.match(alert.remedy, /ShipMates Project: BallsA/u);
});

function fixture(overrides, options = {}) {
  const snapshot = {
    id: "task-001", state: "running", lastEventAt: options.lastEventAt || "2026-07-15T11:40:00.000Z",
    workers: [], validationRequests: [], validationRuns: [], firstmateRuns: [], ...overrides,
  };
  return new FirstmateWatchdog({
    store: {
      rootDir: "/state",
      listTaskIds: async () => [snapshot.id],
      getSnapshot: async () => snapshot,
    },
    projectStore: {
      describeTask: async () => ({
        projectId: "project-b", planTaskId: "interactions",
        projectName: "BallsB", taskName: "Add interactions",
      }),
      updateTaskStatus: async (input) => {
        options.updates?.push(input);
        return { id: input.projectId };
      },
    },
    thresholdMs: 15 * 60_000,
    clock: () => new Date("2026-07-15T12:00:00.000Z"),
    isLiveTask: () => options.live === true,
    read: async () => {
      if (options.terminal) return JSON.stringify(options.terminal);
      const error = new Error("missing"); error.code = "ENOENT"; throw error;
    },
  });
}
