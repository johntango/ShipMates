import assert from "node:assert/strict";
import test from "node:test";

import { projectOperationalState } from "../src/projections/operational-state.js";

test("derives operator state from authoritative evidence and live observations", () => {
  const snapshot = base({
    state: "blocked",
    workers: [{ id: "implementer", status: "reported", report: {
      status: "blocked", summary: "Dependency is unavailable",
    } }],
  });
  const projection = projectOperationalState({
    snapshot, observations: { worker: { status: "exited", pid: 42 } }, source: "dashboard",
  });
  assert.deepEqual(projection.authoritative, {
    taskId: "task-one", state: "blocked", eventsCount: 9,
    lastEventId: "event-9", lastEventAt: "2026-07-25T12:00:00Z",
  });
  assert.deepEqual(projection.blocker, {
    state: "blocked", reason: "worker_blocked", workerId: "implementer",
  });
  assert.equal(projection.observations.worker.status, "exited");
  assert.equal(projection.recovery.evidence.source, "dashboard");
});

test("shows the exact validated commit and delivery destination", () => {
  const projection = projectOperationalState({ snapshot: base({
    state: "complete",
    validationRuns: [{ passed: true, finalHeadSha: "validated-sha", outcome: "passed" }],
    evidence: [{ kind: "local-delivery", value: JSON.stringify({
      repoPath: "/repos/project", baseSha: "base-sha", headSha: "validated-sha",
      method: "fast-forward",
    }) }],
  }) });
  assert.deepEqual(projection.validation, {
    status: "passed", commit: "validated-sha", outcome: "passed",
  });
  assert.deepEqual(projection.delivery, {
    kind: "local",
    destination: { repository: "/repos/project", commit: "validated-sha" },
    operationId: null,
  });
});

test("does not copy prompts, report prose, or unknown live observation fields", () => {
  const projection = projectOperationalState({
    snapshot: base({
      state: "blocked", prompt: "secret",
      workers: [{ id: "worker-one", failure: "secret failure prose" }],
    }),
    observations: {
      worker: { status: "running", token: "secret", prompt: "secret" },
      pullRequest: { number: 7, prompt: "secret", nested: { token: "secret" } },
      prompt: "secret",
      token: "secret",
    },
  });
  assert.deepEqual(projection.observations, {
    worker: { status: "running" }, pullRequest: { number: 7 },
  });
  assert.deepEqual(projection.blocker, {
    state: "blocked", reason: "worker_failed", workerId: "worker-one",
  });
  assert.equal(JSON.stringify(projection).includes("secret"), false);
});

test("projects a GitHub repository and pull request as the delivery destination", () => {
  const projection = projectOperationalState({ snapshot: base({
    state: "complete",
    githubMerges: [{
      status: "completed", operationId: "merge-one", repository: "acme/project",
      prNumber: 17, result: { repository: "acme/project", prNumber: 17, mergeCommitSha: "merge-sha" },
    }],
  }) });
  assert.deepEqual(projection.delivery, {
    kind: "github",
    destination: { repository: "acme/project", pullRequest: 17, commit: "merge-sha" },
    operationId: "merge-one",
  });
});

function base(overrides = {}) {
  return {
    id: "task-one", state: "running", eventsCount: 9, lastEventId: "event-9",
    lastEventAt: "2026-07-25T12:00:00Z", workers: [], validationRuns: [],
    validationRequests: [], evidence: [], githubMerges: [], worktree: null,
    ...overrides,
  };
}
