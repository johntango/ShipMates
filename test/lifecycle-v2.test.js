import assert from "node:assert/strict";
import test from "node:test";

import {
  migrateLifecycleRecords,
  projectLifecycleV2,
  TERMINAL_LIFECYCLE_STATES,
} from "../src/state/lifecycle-v2.js";

test("separates lifecycle state, attempts, and operation state", () => {
  const record = projectLifecycleV2({
    snapshot: base({
      state: "validating",
      gitCommits: [{ operationId: "commit-1", status: "completed" }],
      validationRequests: [{ operationId: "validation-1", status: "requested" }],
      legacyStatus: "do-not-copy",
    }),
    projectTask: {
      taskId: "task-two",
      attempts: [
        { taskId: "task-one", status: "blocked" },
        { taskId: "task-two", status: "dispatched" },
      ],
    },
  });
  assert.deepEqual(record.lifecycle, { state: "validating", owner: "supervisor", terminal: false });
  assert.deepEqual(record.attempts.map(({ attempt, current }) => ({ attempt, current })), [
    { attempt: 1, current: false }, { attempt: 2, current: true },
  ]);
  assert.deepEqual(record.operations.map(({ kind, status }) => ({ kind, status })), [
    { kind: "commit", status: "completed" },
    { kind: "validation", status: "requested" },
  ]);
  assert.equal(JSON.stringify(record).includes("do-not-copy"), false);
});

test("defines terminal states and removes their lifecycle owner", () => {
  assert.deepEqual(TERMINAL_LIFECYCLE_STATES, ["complete", "failed", "cancelled"]);
  for (const state of TERMINAL_LIFECYCLE_STATES) {
    assert.deepEqual(projectLifecycleV2({ snapshot: base({ state }) }).lifecycle,
      { state, owner: null, terminal: true });
  }
});

test("migrates every live record at its exact authoritative watermark", async () => {
  const written = [];
  const records = await migrateLifecycleRecords({
    store: {
      async listTaskIds() { return ["task-one", "task-two"]; },
      async getSnapshot(taskId) { return base({ id: taskId, lastEventId: `${taskId}:event` }); },
    },
    write: async (record) => written.push(record),
  });
  assert.equal(records.length, 2);
  assert.deepEqual(written.map(({ watermark }) => watermark.eventId), [
    "task-one:event", "task-two:event",
  ]);
});

test("migrates ordered project attempts from their containing planned task", async () => {
  const [record] = await migrateLifecycleRecords({
    store: {
      async listTaskIds() { return ["task-two"]; },
      async getSnapshot() { return base({ id: "task-two", workers: [
        { id: "worker-one", status: "completed" },
        { id: "scout-one", status: "running" },
      ] }); },
    },
    projectStore: {
      async describeAttempt() {
        return { projectTask: {
          taskId: "task-two",
          attempts: [
            { taskId: "task-one", status: "blocked" },
            { taskId: "task-two", status: "dispatched" },
          ],
        } };
      },
    },
    write: async () => {},
  });
  assert.deepEqual(record.attempts, [
    { attempt: 1, taskId: "task-one", status: "blocked", current: false },
    { attempt: 2, taskId: "task-two", status: "dispatched", current: true },
  ]);
});

test("does not represent parallel workers as retries", () => {
  const record = projectLifecycleV2({ snapshot: base({ workers: [
    { id: "worker-one", status: "completed" },
    { id: "scout-one", status: "running" },
  ] }) });
  assert.deepEqual(record.attempts, [
    { attempt: 1, taskId: "task-one", status: null, current: true },
  ]);
});

test("projects verified post-merge assurances as terminal operations", () => {
  const record = projectLifecycleV2({ snapshot: base({
    postMergeAssurances: [{ operationId: "assurance-one" }],
  }) });
  assert.deepEqual(record.operations, [{
    kind: "post_merge", operationId: "assurance-one", status: "verified", terminal: true,
  }]);
});

test("fails closed on unknown legacy lifecycle states", () => {
  assert.throws(() => projectLifecycleV2({ snapshot: base({ state: "mystery" }) }),
    /supported task snapshot/u);
});

function base(overrides = {}) {
  return {
    id: "task-one", state: "running", lastEventId: "event-3", eventsCount: 3,
    workers: [], gitCommits: [], validationRequests: [], gitPushes: [],
    githubDraftPullRequests: [], githubMerges: [], postMergeAssurances: [], branchCleanups: [],
    ...overrides,
  };
}
