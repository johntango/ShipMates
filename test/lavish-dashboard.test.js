import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LavishTaskDashboard,
  renderDashboardActionsScript,
  renderLavishTaskDashboard,
} from "../src/adapters/lavish-dashboard.js";

test("renders a readable task dashboard with exact implementation files", () => {
  const html = renderLavishTaskDashboard(snapshot());

  assert.match(html, /ShipMates task dashboard/u);
  assert.match(html, /red\.html/u);
  assert.match(html, /\/treehouse\/task-001\/red\.html/u);
  assert.match(html, /Validation<\/span><strong>Passed/u);
  assert.match(html, /data-shipmates-action="show_files"/u);
  assert.match(html, /value="review_files"/u);
  assert.match(html, /value="review_validation"/u);
  assert.match(html, /value="deliver_changes"/u);
  assert.match(html, /Submit choice/u);
  assert.match(html, /data-shipmates-review-file="0"/u);
  assert.match(html, /src="dashboard-actions\.js"/u);
});

test("describes dashboard actions as queued until Firstmate replies", () => {
  assert.match(
    renderDashboardActionsScript(),
    /queued\. Firstmate will reply in Conversation/u,
  );
});

test("identifies Firstmate as the only Lavish message recipient", () => {
  assert.match(
    renderLavishTaskDashboard(snapshot()),
    /Recipient: Firstmate[\s\S]*Send to Agent[\s\S]*Firstmate only/u,
  );
});

test("escapes untrusted ledger text in the dashboard", () => {
  const value = snapshot();
  value.workers[0].report.summary = '<img src=x onerror="alert(1)">';

  const html = renderLavishTaskDashboard(value);

  assert.doesNotMatch(html, /<img/u);
  assert.match(html, /&lt;img/u);
});

test("does not imply ongoing work for a completed answer with no files", () => {
  const value = snapshot();
  value.state = "clarified";
  value.worktree = null;
  value.workers = [];
  value.gitCommits = [];
  value.validationRuns = [];
  value.firstmateRuns = [{ classification: { requiredAuthority: "read_only" } }];

  const html = renderLavishTaskDashboard(value);

  assert.match(html, /This request did not create or modify any files/u);
  assert.doesNotMatch(html, /files are not ready yet/u);
});

test("reserves not-ready wording for an active implementation", () => {
  const value = snapshot();
  value.state = "running";
  value.workers = [];
  value.gitCommits = [];
  value.validationRuns = [];
  value.firstmateRuns = [{ classification: { requiredAuthority: "local_write" } }];

  assert.match(
    renderLavishTaskDashboard(value),
    /implementation is still running; files are not ready yet/u,
  );
});

test("writes the dashboard beneath task-local ignored state", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-dashboard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dashboard = new LavishTaskDashboard({ stateRoot: root });

  const target = await dashboard.write(snapshot());

  assert.equal(target, path.join(root, "tasks", "task-001", "lavish", "dashboard.html"));
  assert.match(await readFile(target, "utf8"), /green\.html/u);
});

function snapshot() {
  return {
    id: "task-001",
    repo: "owner/repo",
    state: "awaiting_human",
    baseSha: "a".repeat(40),
    worktree: {
      status: "leased",
      repoPath: "/repo",
      worktreePath: "/treehouse/task-001",
      headSha: "b".repeat(40),
    },
    workers: [{
      id: "implementer",
      status: "reported",
      report: {
        status: "completed",
        summary: "Created two pages.",
        files: ["red.html", "green.html"],
      },
    }],
    firstmateRuns: [],
    gitCommits: [{
      status: "completed",
      result: { baseHeadSha: "a".repeat(40), headSha: "b".repeat(40) },
    }],
    validationRuns: [{
      passed: true,
      outcome: "passed",
      finalHeadSha: "b".repeat(40),
    }],
  };
}
