import assert from "node:assert/strict";
import test from "node:test";

import { GitHubHeadMovedError, GitHubStatusWorkflow } from "../src/workflows/github-status.js";

const HEAD = "a".repeat(40);
const MOVED_HEAD = "c".repeat(40);
const BASE = "b".repeat(40);
const AT = "2026-07-13T16:00:00.000Z";

test("records a typed exact-head status report and identifies missing checks", async () => {
  const store = new MemoryStore();
  const gateway = fakeGateway();
  const workflow = new GitHubStatusWorkflow({
    store,
    gateway,
    actor: "firstmate",
    clock: () => new Date(AT),
  });

  const snapshot = await workflow.inspectPullRequest({
    taskId: "github-read-001",
    repository: "johntango/Shipmates-Practice",
    prNumber: 2,
    requiredChecks: ["test", "lint"],
  });

  assert.equal(store.records.length, 1);
  assert.equal(snapshot.report.pullRequest.head.sha, HEAD);
  assert.deepEqual(snapshot.report.requiredChecks, {
    names: ["test", "lint"],
    missing: ["lint"],
    unsuccessful: [],
    satisfied: false,
  });
  assert.equal(snapshot.report.actor, "firstmate");
  assert.equal(snapshot.report.observedAt, AT);
  assert.equal(gateway.pullReads, 2);
});

test("refuses moved-head evidence without writing the ledger", async () => {
  const store = new MemoryStore();
  const gateway = fakeGateway({ confirmedHead: MOVED_HEAD });
  const workflow = new GitHubStatusWorkflow({ store, gateway });

  await assert.rejects(
    workflow.inspectPullRequest({
      taskId: "github-read-001",
      repository: "johntango/Shipmates-Practice",
      prNumber: 2,
      requiredChecks: ["test"],
    }),
    GitHubHeadMovedError,
  );
  assert.equal(store.records.length, 0);
});

test("refuses ambiguous check names", async () => {
  const store = new MemoryStore();
  const gateway = fakeGateway();
  gateway.listCheckRuns = async () => [observation(check()), observation({ ...check(), id: 11 })];
  const workflow = new GitHubStatusWorkflow({ store, gateway });

  await assert.rejects(
    workflow.inspectPullRequest({
      taskId: "github-read-001",
      repository: "johntango/Shipmates-Practice",
      prNumber: 2,
      requiredChecks: ["test"],
    }),
    /Ambiguous check name/u,
  );
  assert.equal(store.records.length, 0);
});

class MemoryStore {
  constructor() {
    this.records = [];
  }

  async getSnapshot() {
    return { repo: "johntango/Shipmates-Practice" };
  }

  async recordGitHubStatus(record) {
    this.records.push(record);
    return { report: record.report };
  }
}

function fakeGateway({ confirmedHead = HEAD } = {}) {
  return {
    pullReads: 0,
    async readRepository() {
      return observation({ nameWithOwner: "johntango/Shipmates-Practice", defaultBranch: "main" });
    },
    async readPullRequest() {
      this.pullReads += 1;
      return observation(pullRequest(this.pullReads === 1 ? HEAD : confirmedHead));
    },
    async readBranchProtection() {
      return observation({ repository: "johntango/Shipmates-Practice", branch: "main" });
    },
    async listCheckRuns() {
      return [observation(check())];
    },
    async listReviews() {
      return [];
    },
    async listWorkflowRuns() {
      return [];
    },
  };
}

function pullRequest(headSha) {
  return {
    repository: "johntango/Shipmates-Practice",
    number: 2,
    base: { branch: "main", sha: BASE },
    head: { branch: "task-2", sha: headSha },
  };
}

function check() {
  return { id: 10, name: "test", headSha: HEAD, status: "completed", conclusion: "success" };
}

function observation(value) {
  return {
    ...value,
    observedAt: AT,
    source: { kind: "github-rest", endpoint: "test-fixture" },
  };
}
