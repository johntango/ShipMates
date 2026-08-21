import assert from "node:assert/strict";
import test from "node:test";

import {
  projectTaskPresentation,
  renderFirstmateOneShotOutput,
  renderTaskPresentation,
} from "../src/projections/task-presentation.js";

test("presents a passing task before its detailed evidence", () => {
  const presentation = projectTaskPresentation({
    id: "task-pass", state: "complete", lastEventAt: "2026-08-17T12:00:00Z",
    workers: [{ id: "scout", status: "reported", report: {
      status: "completed", summary: "Inspection complete",
      tests: [{ command: "npm test", result: "passed" }], files: ["report.md"],
    } }],
    firstmateRuns: [{ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }],
    evidence: [], validationRuns: [{ passed: true, outcome: "passed", durationMs: 42 }],
  });

  assert.equal(presentation.status, "Passed");
  assert.equal(presentation.nextAction, null);
  assert.deepEqual(presentation.evidence.metrics, {
    tokens: { input: 10, output: 5, total: 15 }, validationDurationMs: 42,
  });
  const summary = renderTaskPresentation(presentation, { subject: "Inspection" });
  assert.match(summary, /^Inspection: Passed\nNext action: None\.\nWhy:/u);
  assert.doesNotMatch(summary, /npm test: passed/u);
  const detail = renderTaskPresentation(presentation, { subject: "Inspection", detail: true });
  assert.match(detail, /Tests:\n- npm test: passed \(scout\)/u);
  assert.match(detail, /Metrics: 15 total tokens, 10 input, 5 output; 42 ms validation\./u);
});

test("one-shot output is concise by default and preserves opt-in JSON", () => {
  const input = {
    taskId: "task-demo", requestId: "request-demo", reused: false,
    classification: { recommendedNextStep: "Review the findings." },
    usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    snapshot: {
      id: "task-demo", state: "clarified", eventsCount: 4,
      lastEventId: "classified", lastEventAt: "2026-08-17T12:00:00Z",
      workers: [], evidence: [], validationRuns: [],
    },
    execution: {
      status: "inspected", scouts: [{ workerId: "scout-1", threadId: "thread-1", report: {
        status: "completed", summary: "Inspection complete", files: ["report.md"],
        tests: [], risks: [],
      } }], implementation: null,
    },
  };
  const human = renderFirstmateOneShotOutput(input);
  assert.match(human, /^Firstmate task task-demo: Passed\nNext action: None\.\nWhy:/u);
  assert.match(human, /rerun this command with --json/u);
  assert.doesNotMatch(human, /"classification"/u);

  const structured = JSON.parse(renderFirstmateOneShotOutput({ ...input, json: true }));
  assert.equal(structured.taskId, "task-demo");
  assert.equal(structured.execution.scouts[0].report.summary, "Inspection complete");
  assert.deepEqual(structured.usage, input.usage);
});

test("one-shot classify-only output explains that no worker launched", () => {
  const output = renderFirstmateOneShotOutput({
    taskId: "task-classify", requestId: "request-classify", reused: false,
    classification: { recommendedNextStep: "Inspect after approval." }, usage: {},
    snapshot: { id: "task-classify", state: "clarified", workers: [], evidence: [], validationRuns: [] },
    execution: null,
  });
  assert.match(output, /Firstmate task task-classify: Passed/u);
  assert.match(output, /Next action: Inspect after approval\./u);
  assert.match(output, /no worker was launched/u);
});

test("treats authority and environment limitations as blocked safely", () => {
  const presentation = projectTaskPresentation({
    id: "task-safe", state: "failed", workers: [{
      id: "scout", status: "failed",
      failure: { message: "Sandbox permission denied for the requested capability" },
    }], evidence: [], validationRuns: [],
  }, { reconciliation: {
    action: "request_human_approval", reason: "The environment denied authority.",
  } });

  assert.equal(presentation.status, "Blocked safely");
  assert.equal(presentation.nextAction, "request human approval.");
  assert.match(presentation.why, /Sandbox permission denied/u);
});

test("reports exhausted safe Treehouse capacity as blocked rather than preparing", () => {
  const presentation = projectTaskPresentation({
    id: "task-capacity", state: "blocked", workers: [], evidence: [], validationRuns: [],
  }, { execution: {
    status: "failed",
    failure: { message: "Treehouse capacity is unavailable; active and ambiguous leases were preserved" },
  } });

  assert.equal(presentation.status, "Blocked safely");
  assert.doesNotMatch(presentation.nextAction, /Wait for the active work/u);
  assert.match(presentation.why, /capacity is unavailable/u);
});

test("reports genuine validation failures without inventing metrics", () => {
  const presentation = projectTaskPresentation({
    id: "task-fail", state: "validating", workers: [], evidence: [],
    validationRuns: [{ passed: false, outcome: "tests_failed" }],
  });

  assert.equal(presentation.status, "Failed");
  assert.match(presentation.nextAction, /focused repair/u);
  assert.deepEqual(presentation.evidence.metrics, {});
  assert.match(renderTaskPresentation(presentation, { detail: true }), /Metrics: unavailable\./u);
});

test("reports substantive failure even when a safe blocker is also present", () => {
  const presentation = projectTaskPresentation({
    id: "task-mixed", state: "failed", evidence: [], validationRuns: [],
    workers: [{
      id: "scout", status: "failed", failure: { message: "Sandbox permission denied" },
    }, {
      id: "implementer", status: "failed", failure: { message: "Tests corrupted the output" },
    }],
  });

  assert.equal(presentation.status, "Failed");
  assert.match(presentation.why, /Tests corrupted the output/u);
});

test("presents durable read-only terminal evidence as passed after restart", () => {
  const presentation = projectTaskPresentation({
    id: "task-recovered", state: "clarified", workers: [], validationRuns: [],
    evidence: [{ kind: "read-only-inspection-terminal", value: JSON.stringify({
      requestId: "request-recovered", status: "completed", exitCode: 0,
    }) }],
  });
  assert.equal(presentation.status, "Passed");
  assert.equal(presentation.nextAction, null);
});
