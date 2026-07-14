import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  replayTaskEvents,
  TaskStateError,
} from "../src/core/task-state.js";

test("replays task events into a deterministic snapshot", () => {
  const events = [
    event("created", "task.created", {
      kind: "code-change",
      repo: "johntango/Shipmates-Practice",
      baseSha: "abc123",
    }),
    event("clarified", "task.transitioned", {
      from: "proposed",
      to: "clarified",
    }),
    event("proof", "task.evidence.recorded", {
      kind: "test-run",
      value: "node --test: pass",
    }),
    event("approval", "task.approval.recorded", {
      repo: "johntango/Shipmates-Practice",
      prNumber: 2,
      headSha: "def456",
      mergeMethod: "squash",
      decision: "approved",
    }),
    event("github", "github.status.recorded", {
      report: githubStatusReport(),
    }),
  ];

  const snapshot = replayTaskEvents(events);

  assert.equal(snapshot.state, "clarified");
  assert.equal(snapshot.eventsCount, 5);
  assert.equal(snapshot.evidence[0].kind, "test-run");
  assert.equal(snapshot.approvals[0].headSha, "def456");
  assert.equal(snapshot.githubObservations[0].pullRequest.number, 2);
});

test("rejects invalid and stale transitions", () => {
  assert.throws(
    () =>
      replayTaskEvents([
        createdEvent(),
        event("skip", "task.transitioned", {
          from: "proposed",
          to: "running",
        }),
      ]),
    /Invalid task transition/u,
  );

  assert.throws(
    () =>
      replayTaskEvents([
        createdEvent(),
        event("stale", "task.transitioned", {
          from: "clarified",
          to: "approved_for_dispatch",
        }),
      ]),
    /Stale transition/u,
  );
});

test("rejects duplicate event ids and malformed evidence", () => {
  assert.throws(
    () =>
      replayTaskEvents([
        createdEvent(),
        event("created", "task.evidence.recorded", {
          kind: "test",
          value: "pass",
        }),
      ]),
    /Duplicate event id/u,
  );

  assert.throws(
    () =>
      replayTaskEvents([
        createdEvent(),
        event("empty-proof", "task.evidence.recorded", {
          kind: "test",
          value: "",
        }),
      ]),
    TaskStateError,
  );
});

test("orders timestamps by instant rather than ISO string spelling", () => {
  const events = [
    createdEvent({ at: "2026-07-13T10:00:00.000Z" }),
    event(
      "later",
      "task.evidence.recorded",
      { kind: "clock", value: "later instant" },
      "2026-07-13T06:00:00.000-05:00",
    ),
  ];

  assert.equal(replayTaskEvents(events).eventsCount, 2);
});

test("rejects GitHub evidence for the wrong repository or head SHA", () => {
  const wrongRepository = githubStatusReport();
  wrongRepository.repository.nameWithOwner = "someone/else";
  assert.throws(
    () => replayTaskEvents([createdEvent(), event("github", "github.status.recorded", { report: wrongRepository })]),
    /does not match the task/u,
  );

  const wrongHead = githubStatusReport();
  wrongHead.checks[0].headSha = "c".repeat(40);
  assert.throws(
    () => replayTaskEvents([createdEvent(), event("github", "github.status.recorded", { report: wrongHead })]),
    /does not match the PR head SHA/u,
  );
});

test("records capability-limited local validation and rejects a remote step", () => {
  const report = localValidationReport();
  const lifecycle = validationLifecycleEvents(report).slice(0, -1);
  const snapshot = replayTaskEvents(lifecycle);
  assert.equal(snapshot.validationRuns[0].passed, true);

  const unsafe = localValidationReport();
  unsafe.steps.find(({ step }) => step === "push").status = "completed";
  assert.throws(
    () => replayTaskEvents(validationLifecycleEvents(unsafe).slice(0, -1)),
    /remote step push was not skipped/u,
  );
});

test("blocks human review until local validation passes for the active lease", () => {
  const passedEvents = validationLifecycleEvents(localValidationReport());
  assert.equal(replayTaskEvents(passedEvents).state, "awaiting_human");

  const failed = localValidationReport();
  failed.passed = false;
  failed.outcome = "blocked";
  failed.runStatus = "failed";
  failed.process.exitCode = 1;
  assert.throws(
    () => replayTaskEvents(validationLifecycleEvents(failed)),
    /passing local validation.*required/u,
  );
});

test("records a self-consistent recovery audit at the exact ledger watermark", () => {
  const events = [
    createdEvent(),
    event("recovery", "recovery.audit.recorded", {
      report: {
        schemaVersion: 1,
        taskId: "ledger-test-001",
        auditId: "restart-001",
        actor: "firstmate",
        observedAt: "2026-07-13T10:00:00.000Z",
        auditedEventId: "created",
        auditedEventsCount: 1,
        taskState: "proposed",
        checks: [
          { kind: "ledger", status: "pass", detail: "Replay passed" },
          {
            kind: "github",
            status: "recovery_required",
            detail: "Head moved",
            action: "refresh_github_evidence_before_resuming",
          },
        ],
        safeToResume: false,
        recommendedActions: ["refresh_github_evidence_before_resuming"],
      },
    }),
  ];
  const snapshot = replayTaskEvents(events);
  assert.equal(snapshot.recoveryAudits[0].safeToResume, false);

  events[1].data.report.safeToResume = true;
  assert.throws(() => replayTaskEvents(events), /safeToResume is inconsistent/u);
});

test("records typed Firstmate runs and rejects inconsistent authority", () => {
  const classification = {
    schemaVersion: 1,
    summary: "Inspect the repository.",
    taskType: "review",
    requiredAuthority: "read_only",
    approvalBoundary: "none",
    recommendedNextStep: "Inspect and report findings.",
    requiresHumanApproval: false,
  };
  const events = [
    event("created", "task.created", {
      kind: "firstmate-intake",
      repo: "johntango/Shipmates-Practice",
      baseSha: "abc123",
    }),
    event("requested", "firstmate.run.requested", {
      requestId: "request-001",
      attemptId: "attempt-001",
      requestSha256: "a".repeat(64),
      model: "gpt-5.6-luna",
      maxTurns: 1,
      tracingEnabled: false,
      storeResponse: false,
    }),
    event("classified", "firstmate.run.classified", {
      requestId: "request-001",
      requestEventId: "requested",
      classification,
      usage: {
        requests: 1,
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      },
    }),
  ];

  const snapshot = replayTaskEvents(events);
  assert.equal(snapshot.firstmateRuns[0].status, "classified");

  classification.requiredAuthority = "external_write";
  assert.throws(
    () => replayTaskEvents(events),
    /approval boundary is inconsistent/u,
  );
});

test("binds draft PR creation to human approval and the validated leased head", () => {
  const title = "Practice draft";
  const binding = {
    repository: "johntango/Shipmates-Practice",
    headBranch: "feature/local-gate",
    headSha: "a".repeat(40),
    baseBranch: "main",
    titleSha256: createHash("sha256").update(title).digest("hex"),
    bodySha256: createHash("sha256").update("Body").digest("hex"),
  };
  const lifecycle = validationLifecycleEvents(localValidationReport()).slice(0, -1);
  const snapshot = replayTaskEvents([
    ...lifecycle,
    event("draft-approved", "github.draft_pr.approved", {
      approvalId: "approval-001",
      ...binding,
      decision: "approved",
      approverType: "human",
    }),
    event("draft-requested", "github.draft_pr.create.requested", {
      operationId: "create-001",
      approvalId: "approval-001",
      approvalEventId: "draft-approved",
      ...binding,
    }),
    event("draft-completed", "github.draft_pr.create.completed", {
      operationId: "create-001",
      requestEventId: "draft-requested",
      pullRequest: {
        repository: binding.repository,
        number: 3,
        url: "https://github.com/johntango/Shipmates-Practice/pull/3",
        state: "open",
        draft: true,
        title,
        base: { repository: binding.repository, branch: "main", sha: "d".repeat(40) },
        head: {
          repository: binding.repository,
          owner: "johntango",
          branch: binding.headBranch,
          sha: binding.headSha,
        },
        updatedAt: "2026-07-13T10:00:00.000Z",
        observedAt: "2026-07-13T10:00:00.000Z",
        source: { kind: "github-rest", endpoint: "repos/johntango/Shipmates-Practice/pulls/3" },
      },
    }),
  ]);

  assert.equal(snapshot.githubDraftPrApprovals[0].consumedBy, "create-001");
  assert.equal(snapshot.githubDraftPullRequests[0].status, "completed");
  assert.equal(snapshot.githubDraftPullRequests[0].pullRequest.number, 3);
});

function createdEvent({ at = "2026-07-13T10:00:00.000Z" } = {}) {
  return event(
    "created",
    "task.created",
    {
      kind: "code-change",
      repo: "johntango/Shipmates-Practice",
      baseSha: "abc123",
    },
    at,
  );
}

function event(id, type, data, at = "2026-07-13T10:00:00.000Z") {
  return {
    id,
    taskId: "ledger-test-001",
    type,
    at,
    actor: "firstmate",
    data,
  };
}

function githubStatusReport() {
  const headSha = "a".repeat(40);
  const observedAt = "2026-07-13T10:00:00.000Z";
  const source = { kind: "github-rest", endpoint: "fixture" };
  return {
    schemaVersion: 1,
    actor: "firstmate",
    observedAt,
    repository: {
      nameWithOwner: "johntango/Shipmates-Practice",
      observedAt,
      source,
    },
    pullRequest: {
      repository: "johntango/Shipmates-Practice",
      number: 2,
      base: { sha: "b".repeat(40) },
      head: { sha: headSha },
      observedAt,
      source,
    },
    branchProtection: { observedAt, source },
    checks: [{
      name: "test",
      headSha,
      status: "completed",
      conclusion: "success",
      observedAt,
      source,
    }],
    reviews: [],
    workflowRuns: [],
    requiredChecks: {
      names: ["test"],
      missing: [],
      unsuccessful: [],
      satisfied: true,
    },
  };
}

function localValidationReport() {
  const headSha = "a".repeat(40);
  const names = [
    "intent",
    "rebase",
    "review",
    "test",
    "document",
    "lint",
    "push",
    "pr",
    "ci",
  ];
  const skipped = new Set(["rebase", "push", "pr", "ci"]);
  return {
    schemaVersion: 1,
    taskId: "ledger-test-001",
    mode: "local-only",
    remoteOperations: false,
    intentSha256: createHash("sha256").update("Validate locally").digest("hex"),
    tool: {
      name: "no-mistakes",
      binary: "/private/tmp/no-mistakes",
      pinned: true,
      version: "v1.37.0",
      sourceCommit: "d".repeat(40),
      binarySha256: "e".repeat(64),
    },
    startedAt: "2026-07-13T10:00:00.000Z",
    completedAt: "2026-07-13T10:00:00.000Z",
    branch: "feature/local-gate",
    initialHeadSha: headSha,
    finalHeadSha: headSha,
    headChanged: false,
    runId: "run-local-1",
    runStatus: "completed",
    outcome: "passed",
    passed: true,
    gate: null,
    command: {
      args: ["axi", "run", "--intent", "Validate locally", "--skip", "rebase,push,pr,ci"],
      skipSteps: ["rebase", "push", "pr", "ci"],
    },
    steps: names.map((step) => ({
      step,
      status: skipped.has(step) ? "skipped" : "completed",
      findings: 0,
      durationMs: 0,
    })),
    process: {
      exitCode: 0,
      stdoutSha256: "b".repeat(64),
      stderrSha256: "c".repeat(64),
    },
  };
}

function validationLifecycleEvents(report) {
  const headSha = "a".repeat(40);
  return [
    event("validation-created", "task.created", {
      kind: "code-change",
      repo: "johntango/Shipmates-Practice",
      baseSha: headSha,
    }),
    event("validation-clarified", "task.transitioned", { from: "proposed", to: "clarified" }),
    event("validation-approved", "task.transitioned", { from: "clarified", to: "approved_for_dispatch" }),
    event("validation-preparing", "task.transitioned", { from: "approved_for_dispatch", to: "preparing" }),
    event("validation-lease-request", "worktree.lease.requested", {
      repoPath: "/tmp/repo",
      baseSha: headSha,
    }),
    event("validation-leased", "worktree.leased", {
      requestEventId: "validation-lease-request",
      repoPath: "/tmp/repo",
      worktreePath: "/tmp/worktree",
      headSha,
      branch: "feature/local-gate",
    }),
    event("validation-running", "task.transitioned", { from: "preparing", to: "running" }),
    event("validation-validating", "task.transitioned", { from: "running", to: "validating" }),
    event("validation-result", "validation.local.recorded", { report }),
    event("validation-review", "task.transitioned", { from: "validating", to: "awaiting_human" }),
  ];
}
