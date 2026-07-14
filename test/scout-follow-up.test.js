import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { projectHerdrSnapshot, renderHerdrView } from "../src/projections/herdr.js";
import { TaskStore } from "../src/storage/task-store.js";
import {
  ScoutFollowUpConflictError,
  ScoutFollowUpWorkflow,
} from "../src/workflows/scout-follow-up.js";
import { ScoutSynthesisWorkflow } from "../src/workflows/scout-synthesis.js";

const taskId = "follow-up-task-001";
const headSha = "a".repeat(40);
const worktreePath = "/tmp/treehouse/follow-up/repo";
const workerIds = ["scout-alpha", "scout-beta"];

test("runs one human-selected check through a verified read-only reply", async (t) => {
  const store = await synthesizedTask(t);
  const scoutWorkflow = new FakeScoutWorkflow({ store });
  const workflow = new ScoutFollowUpWorkflow({ store, scoutWorkflow });

  await assert.rejects(
    workflow.run({
      taskId,
      synthesisId: "pair-review-v1",
      followUpId: "follow-up-human-check",
      checkIndex: 0,
      workerId: "scout-alpha",
      replyId: "reply-human-check",
      humanActor: "firstmate",
    }),
    /distinct from the Firstmate actor/u,
  );

  const result = await workflow.run({
    taskId,
    synthesisId: "pair-review-v1",
    followUpId: "follow-up-001",
    checkIndex: 0,
    workerId: "scout-alpha",
    replyId: "reply-follow-up-001",
    humanActor: "captain",
  });

  assert.equal(result.reused, false);
  assert.equal(result.followUp.status, "resolved");
  assert.equal(result.followUp.selectedBy, "captain");
  assert.equal(result.followUp.outcome, "completed");
  assert.deepEqual(result.followUp.counts, { files: 1, tests: 1, risks: 0 });
  assert.match(scoutWorkflow.prompts[0], /human-selected read-only follow-up/u);
  assert.equal(result.snapshot.state, "running");
  assert.equal(result.snapshot.worktree.headSha, headSha);

  const projection = projectHerdrSnapshot(result.snapshot);
  assert.equal(projection.followUps[0].status, "resolved");
  assert.equal(projection.followUps[0].outcome, "completed");
  const rendered = renderHerdrView(projection);
  assert.match(rendered, /follow-up-001: resolved/u);
  assert.doesNotMatch(JSON.stringify(projection), /Follow-up evidence collected/u);

  const eventsBeforeRetry = result.snapshot.eventsCount;
  const retry = await workflow.run({
    taskId,
    synthesisId: "pair-review-v1",
    followUpId: "follow-up-001",
    checkIndex: 0,
    workerId: "scout-alpha",
    replyId: "reply-follow-up-001",
    humanActor: "captain",
  });
  assert.equal(retry.reused, true);
  assert.equal(retry.snapshot.eventsCount, eventsBeforeRetry);
  assert.equal(scoutWorkflow.prompts.length, 1);

  await assert.rejects(
    workflow.run({
      taskId,
      synthesisId: "pair-review-v1",
      followUpId: "follow-up-001",
      checkIndex: 1,
      workerId: "scout-alpha",
      replyId: "reply-follow-up-001",
      humanActor: "captain",
    }),
    ScoutFollowUpConflictError,
  );
});

test("rejects a resolution whose report digest is not the verified reply", async (t) => {
  const store = await synthesizedTask(t);
  const recordResolution = store.recordScoutFollowUpResolution.bind(store);
  store.recordScoutFollowUpResolution = (input) => recordResolution({
    ...input,
    resolution: { ...input.resolution, reportSha256: "f".repeat(64) },
  });
  const workflow = new ScoutFollowUpWorkflow({
    store,
    scoutWorkflow: new FakeScoutWorkflow({ store }),
  });

  await assert.rejects(
    workflow.run({
      taskId,
      synthesisId: "pair-review-v1",
      followUpId: "follow-up-tampered",
      checkIndex: 0,
      workerId: "scout-alpha",
      replyId: "reply-follow-up-tampered",
      humanActor: "captain",
    }),
    /lacks its verified reply evidence/u,
  );
  const snapshot = await store.getSnapshot(taskId);
  assert.equal(snapshot.scoutFollowUps[0].status, "selected");
  assert.equal(snapshot.workers[0].replies[0].status, "completed");
});

test("reconciles a selected follow-up without repeating an uncertain reply", async (t) => {
  const store = await synthesizedTask(t);
  const scoutWorkflow = new FakeScoutWorkflow({ store, interruptAfterIntent: true });
  const workflow = new ScoutFollowUpWorkflow({ store, scoutWorkflow });
  const input = {
    taskId,
    synthesisId: "pair-review-v1",
    followUpId: "follow-up-recovery",
    checkIndex: 0,
    workerId: "scout-beta",
    replyId: "reply-follow-up-recovery",
    humanActor: "captain",
  };

  await assert.rejects(workflow.run(input), /simulated interruption/u);
  let snapshot = await store.getSnapshot(taskId);
  assert.equal(snapshot.scoutFollowUps[0].status, "selected");
  assert.equal(snapshot.workers[1].replies[0].status, "requested");

  scoutWorkflow.interruptAfterIntent = false;
  const result = await workflow.reconcile({
    taskId,
    followUpId: "follow-up-recovery",
  });
  snapshot = result.snapshot;
  assert.equal(snapshot.scoutFollowUps[0].status, "resolved");
  assert.equal(scoutWorkflow.replyCalls, 1);
  assert.equal(scoutWorkflow.reconcileCalls, 1);
});

class FakeScoutWorkflow {
  constructor({ store, interruptAfterIntent = false }) {
    this.store = store;
    this.interruptAfterIntent = interruptAfterIntent;
    this.prompts = [];
    this.replyCalls = 0;
    this.reconcileCalls = 0;
  }

  async reply({ taskId: id, workerId, replyId, prompt }) {
    this.replyCalls += 1;
    this.prompts.push(prompt);
    const snapshot = await this.store.getSnapshot(id);
    const worker = snapshot.workers.find(({ id: candidate }) => candidate === workerId);
    const requestEventId = `${id}:fake:${replyId}:requested`;
    await this.store.requestWorkerReply({
      taskId: id,
      actor: "firstmate",
      workerId,
      replyId,
      threadId: worker.threadId,
      leaseHeadSha: snapshot.worktree.headSha,
      sandbox: "read-only",
      promptSha256: digest(prompt),
      eventId: requestEventId,
    });
    if (this.interruptAfterIntent) throw new Error("simulated interruption");
    return this.#complete({ id, workerId, replyId, requestEventId });
  }

  async reconcileReply({ taskId: id, workerId, replyId }) {
    this.reconcileCalls += 1;
    const snapshot = await this.store.getSnapshot(id);
    const worker = snapshot.workers.find(({ id: candidate }) => candidate === workerId);
    const reply = worker.replies.find(({ id: candidate }) => candidate === replyId);
    return this.#complete({
      id,
      workerId,
      replyId,
      requestEventId: reply.requestEventId,
    });
  }

  async #complete({ id, workerId, replyId, requestEventId }) {
    const snapshot = await this.store.getSnapshot(id);
    const worker = snapshot.workers.find(({ id: candidate }) => candidate === workerId);
    const reply = worker.replies.find(({ id: candidate }) => candidate === replyId);
    return this.store.recordWorkerReplyCompleted({
      taskId: id,
      actor: "firstmate",
      workerId,
      replyId,
      requestEventId,
      threadId: worker.threadId,
      leaseHeadSha: reply.leaseHeadSha,
      report: followUpReport(),
      verification: {
        noMutation: true,
        headSha,
        branch: null,
        dirty: false,
        eventCount: 1,
      },
      eventId: `${id}:fake:${replyId}:completed`,
    });
  }
}

async function synthesizedTask(t) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "scout-follow-up-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new TaskStore({ rootDir });
  await store.createTask({
    taskId,
    kind: "scout",
    repo: "johntango/Shipmates-Practice",
    baseSha: headSha,
    actor: "firstmate",
    eventId: "created",
  });
  for (const [from, to] of [
    ["proposed", "clarified"],
    ["clarified", "approved_for_dispatch"],
    ["approved_for_dispatch", "preparing"],
  ]) await store.transition({ taskId, from, to, actor: "firstmate", eventId: to });
  await store.requestWorktreeLease({
    taskId,
    actor: "firstmate",
    repoPath: "/repos/practice",
    baseSha: headSha,
    eventId: "lease-request",
  });
  await store.recordWorktreeLease({
    taskId,
    actor: "firstmate",
    requestEventId: "lease-request",
    repoPath: "/repos/practice",
    worktreePath,
    headSha,
    branch: null,
    eventId: "leased",
  });
  await store.transition({
    taskId,
    from: "preparing",
    to: "running",
    actor: "firstmate",
    eventId: "running",
  });
  for (const [index, workerId] of workerIds.entries()) {
    await store.requestWorkerDispatch({
      taskId,
      actor: "firstmate",
      workerId,
      backend: "codex-mcp",
      mode: "scout",
      worktreePath,
      sandbox: "read-only",
      brief: `Inspect area ${index}`,
      briefSha256: `${index + 1}`.repeat(64),
      paneId: `w1:p${index + 2}`,
      eventId: `${workerId}-dispatch`,
    });
  }
  await store.transition({
    taskId,
    from: "running",
    to: "awaiting_worker",
    actor: "firstmate",
    eventId: "awaiting",
  });
  for (const [index, workerId] of workerIds.entries()) {
    const threadId = `thread-${workerId}`;
    await store.recordWorkerStarted({
      taskId,
      actor: "firstmate",
      workerId,
      requestEventId: `${workerId}-dispatch`,
      threadId,
      eventId: `${workerId}-started`,
    });
    await store.recordWorkerReport({
      taskId,
      actor: "firstmate",
      workerId,
      threadId,
      report: scoutReport(index),
      verification: {
        noMutation: true,
        headSha,
        branch: null,
        dirty: false,
        eventCount: 1,
        paneId: `w1:p${index + 2}`,
      },
      eventId: `${workerId}-report`,
    });
  }
  await store.transition({
    taskId,
    from: "awaiting_worker",
    to: "running",
    actor: "firstmate",
    eventId: "workers-finished",
  });
  await new ScoutSynthesisWorkflow({ store }).run({
    taskId,
    synthesisId: "pair-review-v1",
    workerIds,
  });
  return store;
}

function scoutReport(index) {
  return {
    taskId,
    status: "completed",
    summary: index === 0 ? "Runtime inspected." : "Tests inspected.",
    branch: null,
    commit: headSha,
    files: ["src/message.js"],
    tests: [{ command: "npm test", result: index === 0 ? "passed" : "all passed" }],
    risks: index === 0 ? ["Input risk."] : ["Coverage risk."],
  };
}

function followUpReport() {
  return {
    taskId,
    status: "completed",
    summary: "Follow-up evidence collected.",
    branch: null,
    commit: headSha,
    files: ["src/message.js"],
    tests: [{ command: "npm test", result: "passed" }],
    risks: [],
  };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
