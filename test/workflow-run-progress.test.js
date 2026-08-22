import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { workflowProgressMessage } from "../src/workflow-run/progress.js";
import { WorkflowRunStore } from "../src/workflow-run/store.js";

test("reports meaningful durable transitions once without internal identifiers", async () => {
  const messages = [];
  const store = new WorkflowRunStore({
    rootDir: await mkdtemp(path.join(tmpdir(), "workflow-progress-")),
    idFactory: () => "private-run-id",
    onEvent: (event) => {
      const message = workflowProgressMessage(event);
      if (message) messages.push(message);
    },
  });
  const run = await store.create({
    request: "Build a page", plan: "Build and validate", repoPath: "/repo",
    baseHeadSha: "a".repeat(40), authority: "local_write",
  });
  await store.append(run.id, "workflow.approved", {}, "approved");
  await store.append(run.id, "worker.launch_requested", { operationId: "worker-op" }, "launch-requested");
  await store.append(run.id, "worker.launched", {
    operationId: "worker-op", receipt: { pid: 10 },
  }, "launched");
  await store.append(run.id, "worker.launched", {
    operationId: "worker-op", receipt: { pid: 10 },
  }, "launched");

  assert.deepEqual(messages, [
    "Status: Working\nNext: No action needed; First Mate is monitoring the isolated Implementer.\nWhy: The Implementer is active in the isolated workspace.",
  ]);
  assert.doesNotMatch(messages.join(" "), /private-run-id|worker-op/u);
  const replayed = await new WorkflowRunStore({ rootDir: store.rootDir }).get(run.id);
  assert.equal(replayed.phase, "implementing");
  assert.equal(messages.length, 1);
});

test("renders validation, review, completion, and blocked transitions in plain language", () => {
  assert.match(workflowProgressMessage({ type: "validation.requested" }), /^Status: Validating/u);
  assert.equal(workflowProgressMessage({
    type: "validation.review_requested",
    data: { review: { summary: "Browser evidence is unavailable.\nPlease review." } },
  }), "Status: Awaiting your approval\nNext: Choose whether to accept this validation risk or stop safely.\nWhy: Browser evidence is unavailable. Please review.");
  assert.match(workflowProgressMessage({ type: "workflow.completed" }), /Implementer created the code/iu);
  const completion = workflowProgressMessage({ type: "workflow.completed" }, {
    validation: { report: {
      generatedTestCount: 0, executedTestCaseCount: 4,
      steps: [{ step: "test", status: "completed" }],
    }, status: "passed", headSha: "a".repeat(40) },
    worker: {
      workspacePath: "/isolated/candidate", status: "completed", headSha: "a".repeat(40),
      report: { status: "completed", files: ["site/index.html"] },
    },
    phase: "completed",
  });
  assert.match(completion, /Implementer created the code.*No-mistakes tested.*passed/isu);
  assert.match(completion, /Candidate page: file:\/\/\/isolated\/candidate\/site\/index\.html/iu);
  assert.ok(completion.indexOf("Candidate page:") < completion.indexOf("Created:"));
  assert.match(completion, /1 check: tests.*generated no new project tests.*ran 4 recorded test cases/isu);
  assert.match(workflowProgressMessage({ type: "workflow.blocked" }), /^Status: Blocked safely/u);
  assert.equal(workflowProgressMessage({ type: "worker.launch_requested" }), null);
});
