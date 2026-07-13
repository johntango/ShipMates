import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskStore } from "../src/storage/task-store.js";
import {
  ScoutSynthesisArtifactError,
  ScoutSynthesisAuthorityError,
  ScoutSynthesisWorkflow,
} from "../src/workflows/scout-synthesis.js";

const taskId = "synthesis-task-001";
const headSha = "a".repeat(40);
const worktreePath = "/tmp/treehouse/synthesis/repo";
const workerIds = ["scout-alpha", "scout-beta"];

test("records a deterministic comparison without advancing task authority", async (t) => {
  const store = await pairedTask(t);
  const workflow = new ScoutSynthesisWorkflow({ store });

  const first = await workflow.run({
    taskId,
    synthesisId: "pair-review-v1",
    workerIds,
  });

  assert.equal(first.reused, false);
  assert.equal(first.snapshot.state, "running");
  assert.equal(first.snapshot.validationRuns.length, 0);
  assert.equal(first.snapshot.scoutSyntheses.length, 1);
  assert.equal(first.artifact.outcome, "review_required");
  assert.equal(first.artifact.sources.length, 2);
  assert.deepEqual(
    first.artifact.agreements.filter(({ kind }) => kind === "file").map(({ key }) => key),
    ["package.json", "src/message.js"],
  );
  assert.equal(first.artifact.disagreements.some(({ kind, key }) =>
    kind === "test" && key === "npm test"), true);
  assert.equal(first.artifact.unsupportedClaims.some(({ workerId, kind }) =>
    workerId === "scout-beta" && kind === "test"), true);
  assert.equal(first.artifact.followUpChecks.some(({ action }) =>
    action === "rerun_test"), true);

  const record = first.snapshot.scoutSyntheses[0];
  const before = await readFile(path.join(store.rootDir, record.artifactPath), "utf8");
  const second = await workflow.run({
    taskId,
    synthesisId: "pair-review-v1",
    workerIds,
  });
  const after = await readFile(path.join(store.rootDir, record.artifactPath), "utf8");
  assert.equal(second.reused, true);
  assert.equal(second.snapshot.eventsCount, first.snapshot.eventsCount);
  assert.equal(after, before);
});

test("fails closed for an unverified or differently bound scout", async (t) => {
  const store = await pairedTask(t, { secondHeadSha: "b".repeat(40) });
  const workflow = new ScoutSynthesisWorkflow({ store });

  await assert.rejects(
    workflow.run({ taskId, synthesisId: "authority-check", workerIds }),
    ScoutSynthesisAuthorityError,
  );
  assert.equal((await store.getSnapshot(taskId)).scoutSyntheses.length, 0);
});

test("refuses a changed artifact instead of regenerating or rebinding it", async (t) => {
  const store = await pairedTask(t);
  const workflow = new ScoutSynthesisWorkflow({ store });
  const first = await workflow.run({
    taskId,
    synthesisId: "tamper-check",
    workerIds,
  });
  const target = path.join(
    store.rootDir,
    first.snapshot.scoutSyntheses[0].artifactPath,
  );
  await writeFile(target, "{}\n");

  await assert.rejects(
    workflow.run({ taskId, synthesisId: "tamper-check", workerIds }),
    ScoutSynthesisArtifactError,
  );
});

async function pairedTask(t, { secondHeadSha = headSha } = {}) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "scout-synthesis-"));
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
  ]) {
    await store.transition({ taskId, from, to, actor: "firstmate", eventId: to });
  }
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
      report: report(index),
      verification: {
        noMutation: true,
        headSha: index === 1 ? secondHeadSha : headSha,
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
  return store;
}

function report(index) {
  return {
    taskId,
    status: "completed",
    summary: index === 0 ? "Runtime behavior inspected." : "Tests inspected.",
    branch: null,
    commit: headSha,
    files: index === 0
      ? ["src/message.js", "package.json"]
      : ["package.json", "src/message.js"],
    tests: index === 0
      ? [{ command: "npm test", result: "5 passed" }]
      : [
        { command: "npm test", result: "All five passed" },
        { command: "node --test", result: "5 passed" },
      ],
    risks: index === 0 ? ["Inputs are not validated."] : ["No coverage threshold."],
  };
}
