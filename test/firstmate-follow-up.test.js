import assert from "node:assert/strict";
import test from "node:test";

import {
  isFirstmateTaskFollowUp,
  isFirstmateProjectContinuation,
  renderLavishReadOnlyAction,
  renderTaskArtifactSummary,
  resolveArtifactFollowUpSnapshot,
  resolveLavishReviewFile,
  taskArtifactSummary,
} from "../src/cli/firstmate-follow-up.js";

test("recognizes artifact follow-ups without treating new build requests as follow-ups", () => {
  assert.equal(isFirstmateTaskFollowUp("display the files"), true);
  assert.equal(isFirstmateTaskFollowUp("where are they located?"), true);
  assert.equal(isFirstmateTaskFollowUp("open the pages"), true);
  assert.equal(isFirstmateTaskFollowUp("develop two separate web pages"), false);
});

test("recognizes project revisions without capturing fresh projects", () => {
  assert.equal(isFirstmateProjectContinuation(
    "Modify the existing implementation to accept a string containing letters",
  ), true);
  assert.equal(isFirstmateProjectContinuation("make the page background blue"), true);
  assert.equal(isFirstmateProjectContinuation("Can you change the existing page?"), true);
  assert.equal(isFirstmateProjectContinuation("develop a new accounting website"), false);
  assert.equal(isFirstmateProjectContinuation("create two separate web pages"), false);
});

test("finds the newest artifact-producing task without asking for an id", async () => {
  const snapshots = new Map([
    ["task-pages", {
      id: "task-pages",
      state: "validating",
      lastEventAt: "2026-07-14T21:35:00Z",
      worktree: { worktreePath: "/treehouse/pages" },
      workers: [{ id: "implementer", report: { files: ["home.html"] } }],
    }],
    ["task-empty", {
      id: "task-empty",
      state: "clarified",
      lastEventAt: "2026-07-14T21:37:00Z",
      workers: [],
    }],
  ]);
  const store = {
    listTaskIds: async () => [...snapshots.keys()],
    getSnapshot: async (id) => snapshots.get(id),
  };

  const result = await resolveArtifactFollowUpSnapshot({
    store,
    preferredTaskId: "task-empty",
  });

  assert.equal(result.id, "task-pages");
});

test("keeps a currently running request as the conversational target", async () => {
  const pending = {
    id: "task-running",
    state: "running",
    lastEventAt: "2026-07-14T21:38:00Z",
    workers: [],
  };
  const store = {
    listTaskIds: async () => ["task-running"],
    getSnapshot: async () => pending,
  };

  const result = await resolveArtifactFollowUpSnapshot({
    store,
    preferredTaskId: "task-running",
    activeTaskIds: ["task-running"],
  });

  assert.equal(result, pending);
});

test("keeps the explicit active project ahead of newer unrelated artifacts", async () => {
  const project = {
    id: "task-project",
    state: "validating",
    lastEventAt: "2026-07-14T21:30:00Z",
    worktree: { worktreePath: "/treehouse/project" },
    workers: [{ id: "implementer", report: { files: ["index.html"] } }],
  };
  const unrelated = {
    id: "task-unrelated",
    state: "validating",
    lastEventAt: "2026-07-14T21:40:00Z",
    worktree: { worktreePath: "/treehouse/unrelated" },
    workers: [{ id: "implementer", report: { files: ["internal.js"] } }],
  };
  const snapshots = new Map([[project.id, project], [unrelated.id, unrelated]]);
  const store = {
    listTaskIds: async () => [...snapshots.keys()],
    getSnapshot: async (id) => snapshots.get(id),
  };

  const result = await resolveArtifactFollowUpSnapshot({
    store,
    preferredTaskId: project.id,
  });

  assert.equal(result, project);
});

test("resolves an HTML review action inside the exact task worktree", () => {
  const snapshot = {
    id: "task-001",
    worktree: { worktreePath: "/treehouse/task-001" },
    workers: [{ id: "implementer", report: { files: ["red.html", "notes.txt"] } }],
  };

  assert.deepEqual(resolveLavishReviewFile(snapshot, {
    taskId: "task-001", action: "review_file", fileIndex: 0,
  }), {
    filename: "red.html",
    path: "/treehouse/task-001/red.html",
  });
  assert.throws(() => resolveLavishReviewFile(snapshot, {
    taskId: "task-001", action: "review_file", fileIndex: 1,
  }), /HTML artifact/u);
});

test("handles only read-only Lavish task actions", () => {
  const snapshot = {
    id: "task-001",
    state: "awaiting_human",
    worktree: { worktreePath: "/treehouse/task-001" },
    workers: [{ id: "implementer", report: { files: ["red.html"] } }],
    validationRuns: [{ passed: true, outcome: "passed" }],
  };

  assert.match(renderLavishReadOnlyAction(snapshot, {
    taskId: "task-001", action: "show_files",
  }), /red\.html/u);
  assert.match(renderLavishReadOnlyAction(snapshot, {
    taskId: "task-001", action: "show_validation",
  }), /passed/u);
  assert.match(renderLavishReadOnlyAction(snapshot, {
    taskId: "task-001", decision: "review_files",
  }), /Selected: review/u);
  assert.match(renderLavishReadOnlyAction(snapshot, {
    taskId: "task-001", decision: "no_action",
  }), /No workflow was started/u);
  assert.throws(() => renderLavishReadOnlyAction(snapshot, {
    taskId: "task-001", action: "approve_push",
  }), /Unsupported/u);
});

test("explains intentionally skipped validation for completed demo work", () => {
  const snapshot = {
    id: "task-demo-001",
    state: "complete",
    evidence: [{ kind: "demo-validation-skipped" }],
    validationRuns: [],
  };
  const context = { projectName: "TestA", taskName: "Add automated test coverage" };

  assert.equal(renderLavishReadOnlyAction(snapshot, {
    taskId: snapshot.id, action: "show_validation",
  }, context),
  "“Add automated test coverage” in TestA completed in local-only demo mode; pipeline validation and remote operations were intentionally skipped.");
  assert.match(renderLavishReadOnlyAction(snapshot, {
    taskId: snapshot.id, decision: "review_validation",
  }, context), /Selected: review validation.*intentionally skipped/u);
});

test("renders exact implementation file locations for the prior task", () => {
  const summary = taskArtifactSummary({
    id: "task-001",
    state: "validating",
    worktree: { worktreePath: "/treehouse/task-001" },
    workers: [{ id: "implementer", report: { files: ["red.html", "green.html"] } }],
  });

  assert.equal(summary.ready, true);
  assert.doesNotMatch(renderTaskArtifactSummary(summary), /^Task\s/u);
  assert.match(renderTaskArtifactSummary(summary), /red\.html: \/treehouse\/task-001\/red\.html/u);
  assert.match(renderTaskArtifactSummary(summary), /green\.html/u);
});

test("uses human project and task names instead of internal task ids", () => {
  const snapshot = {
    id: "task-internal-001",
    state: "validating",
    worktree: { worktreePath: "/treehouse/page" },
    workers: [{ id: "implementer", report: { files: ["index.html"] } }],
    validationRuns: [],
  };
  const context = { projectName: "BallsA", taskName: "Build the play interface" };

  assert.match(renderTaskArtifactSummary(taskArtifactSummary(snapshot), context),
    /“Build the play interface” in BallsA/u);
  assert.doesNotMatch(renderTaskArtifactSummary(taskArtifactSummary(snapshot), context),
    /task-internal/u);
  assert.match(renderLavishReadOnlyAction(snapshot, {
    taskId: snapshot.id, action: "show_status",
  }, context), /“Build the play interface” in BallsA is validating/u);
});
