import assert from "node:assert/strict";
import test from "node:test";

import {
  createWatchdogAudit,
  parseMonitorIntervalMs,
  runWithScheduler,
  SerializedScheduler,
} from "../src/monitoring/watchdog-scheduler.js";

test("uses the documented monitor default for invalid configuration", () => {
  for (const value of [undefined, "", "nope", "Infinity", "0", "-2"]) {
    assert.equal(parseMonitorIntervalMs(value), 15_000);
  }
  assert.equal(parseMonitorIntervalMs("2"), 5_000);
  assert.equal(parseMonitorIntervalMs("30"), 30_000);
});

test("contains startup and periodic inspection failures independently", async () => {
  const events = [];
  let inspection = 0;
  const audit = createWatchdogAudit({
    reconcile: async () => events.push("reconciled"),
    terminalizeStale: async () => [],
    inspect: async () => { throw new Error(`inspection ${++inspection}`); },
    onReconciliationError: async (error) => events.push(error.message),
    onTerminalizationError: async (error) => events.push(error.message),
    onInspectionError: async (error) => events.push(error.message),
    onTerminalized: async () => {},
    onAlert: async () => {},
  });

  await audit();
  await audit();
  assert.deepEqual(events, ["reconciled", "inspection 1", "reconciled", "inspection 2"]);
});

test("continues an audit after reconciliation and terminalization failures", async () => {
  const errors = [];
  const alerts = [];
  const audit = createWatchdogAudit({
    reconcile: async () => { throw new Error("reconcile failed"); },
    terminalizeStale: async () => { throw new Error("terminalize failed"); },
    inspect: async () => [{ taskId: "task-1" }],
    onReconciliationError: async (error) => errors.push(error.message),
    onTerminalizationError: async (error) => errors.push(error.message),
    onInspectionError: async (error) => errors.push(error.message),
    onTerminalized: async () => {},
    onAlert: async (alert) => alerts.push(alert.taskId),
  });

  await audit();
  assert.deepEqual(errors, ["reconcile failed", "terminalize failed"]);
  assert.deepEqual(alerts, ["task-1"]);
});

test("runs slow audits serially and schedules only after completion", async () => {
  const timers = new Map();
  let timerId = 0;
  let active = 0;
  let maximumActive = 0;
  let release;
  const scheduler = new SerializedScheduler({
    intervalMs: 10,
    setTimer: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimer: (id) => timers.delete(id),
    task: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => { release = resolve; });
      active -= 1;
    },
    onError: async () => {},
  });

  scheduler.start();
  assert.equal(timers.size, 1);
  const first = timers.values().next().value;
  timers.clear();
  first();
  await Promise.resolve();
  assert.equal(timers.size, 0);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.size, 1);
  assert.equal(maximumActive, 1);
  scheduler.cancel();
});

test("cancels pending and in-flight scheduling during shutdown", async () => {
  const timers = new Map();
  let timerId = 0;
  let release;
  const scheduler = new SerializedScheduler({
    intervalMs: 10,
    setTimer: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimer: (id) => timers.delete(id),
    task: () => new Promise((resolve) => { release = resolve; }),
    onError: async () => {},
  });

  scheduler.start();
  scheduler.cancel();
  assert.equal(timers.size, 0);

  scheduler.start();
  const callback = timers.values().next().value;
  timers.clear();
  callback();
  await Promise.resolve();
  scheduler.cancel();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.size, 0);
});

test("contains a final scheduled-task rejection and keeps scheduling", async () => {
  const timers = [];
  const errors = [];
  const scheduler = new SerializedScheduler({
    intervalMs: 10,
    setTimer: (callback) => { timers.push(callback); return callback; },
    clearTimer: () => {},
    task: async () => { throw new Error("unexpected audit failure"); },
    onError: async (error) => errors.push(error.message),
  });

  scheduler.start();
  timers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ["unexpected audit failure"]);
  assert.equal(timers.length, 1);
  scheduler.cancel();
});

test("cancels the scheduler after an abnormal interactive-loop exit", async () => {
  const events = [];
  const scheduler = {
    start: () => events.push("started"),
    cancel: () => events.push("cancelled"),
  };

  await assert.rejects(runWithScheduler({
    startupTask: async () => events.push("startup audit"),
    scheduler,
    run: async () => { throw new Error("terminal failed"); },
  }), /terminal failed/u);
  assert.deepEqual(events, ["startup audit", "started", "cancelled"]);
});

test("cancels the scheduler when startup itself exits abnormally", async () => {
  const events = [];
  const scheduler = {
    start: () => events.push("started"),
    cancel: () => events.push("cancelled"),
  };

  await assert.rejects(runWithScheduler({
    startupTask: async () => { throw new Error("startup failed"); },
    scheduler,
    run: async () => {},
  }), /startup failed/u);
  assert.deepEqual(events, ["cancelled"]);
});
