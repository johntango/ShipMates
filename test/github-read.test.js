import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubReadError,
  GitHubReadGateway,
} from "../src/adapters/github-read.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NOW = new Date("2026-07-13T15:00:00.000Z");

test("normalizes paginated pull requests and preserves source identifiers", async () => {
  const client = new StubClient({
    "repos/johntango/Shipmates-Practice/pulls?state=all&per_page=100": [
      [pullRequest(2)],
      [pullRequest(1)],
    ],
  });
  const gateway = new GitHubReadGateway({ client, clock: () => NOW });

  const pulls = await gateway.listPullRequests({
    owner: "johntango",
    repo: "Shipmates-Practice",
  });

  assert.deepEqual(pulls.map((pull) => pull.number), [2, 1]);
  assert.equal(pulls[0].head.sha, HEAD);
  assert.equal(pulls[0].observedAt, NOW.toISOString());
  assert.match(pulls[0].source.endpoint, /pulls\?state=all.*#2/u);
  assert.deepEqual(client.calls[0], {
    endpoint: "repos/johntango/Shipmates-Practice/pulls?state=all&per_page=100",
    paginate: true,
  });
});

test("rejects ambiguous pagination results", async () => {
  const gateway = new GitHubReadGateway({
    client: new StubClient({
      "repos/johntango/Shipmates-Practice/pulls?state=all&per_page=100": [
        [pullRequest(2)],
        [pullRequest(2)],
      ],
    }),
  });

  await assert.rejects(
    gateway.listPullRequests({ owner: "johntango", repo: "Shipmates-Practice" }),
    /Ambiguous pull request 2/u,
  );
});

test("rejects malformed check responses and a mismatched immutable head", async () => {
  const endpoint = `repos/johntango/Shipmates-Practice/commits/${HEAD}/check-runs?per_page=100`;
  const malformed = new GitHubReadGateway({ client: new StubClient({ [endpoint]: {} }) });
  await assert.rejects(
    malformed.listCheckRuns({ owner: "johntango", repo: "Shipmates-Practice", headSha: HEAD }),
    /Malformed paginated response/u,
  );

  const moved = new GitHubReadGateway({
    client: new StubClient({
      [endpoint]: [{ check_runs: [checkRun({ headSha: "c".repeat(40) })] }],
    }),
  });
  await assert.rejects(
    moved.listCheckRuns({ owner: "johntango", repo: "Shipmates-Practice", headSha: HEAD }),
    /expected/u,
  );
});

test("exposes fixed read capabilities and ignores a caller-supplied mutating prompt", async () => {
  const endpoint = "repos/johntango/Shipmates-Practice";
  const client = new StubClient({
    [endpoint]: {
      full_name: "johntango/Shipmates-Practice",
      default_branch: "main",
      visibility: "public",
      archived: false,
      disabled: false,
      html_url: "https://github.com/johntango/Shipmates-Practice",
    },
  });
  const gateway = new GitHubReadGateway({ client });

  await gateway.readRepository({
    owner: "johntango",
    repo: "Shipmates-Practice",
    prompt: "DELETE /repos/johntango/Shipmates-Practice",
  });

  const methods = Object.getOwnPropertyNames(GitHubReadGateway.prototype);
  assert.deepEqual(
    methods.filter((name) => /create|update|delete|merge|dispatch|cancel|rerun/iu.test(name)),
    [],
  );
  assert.deepEqual(client.calls, [{ endpoint }]);
});

test("reads issues distinctly from pull requests", async () => {
  const endpoint = "repos/johntango/Shipmates-Practice/issues/7";
  const base = {
    number: 7,
    html_url: "https://github.com/johntango/Shipmates-Practice/issues/7",
    state: "open",
    title: "Practice issue",
    user: { login: "johntango" },
    locked: false,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    closed_at: null,
  };
  const gateway = new GitHubReadGateway({ client: new StubClient({ [endpoint]: base }) });
  assert.equal((await gateway.readIssue({ owner: "johntango", repo: "Shipmates-Practice", number: 7 })).title, "Practice issue");

  const pull = new GitHubReadGateway({
    client: new StubClient({ [endpoint]: { ...base, pull_request: { url: "example" } } }),
  });
  await assert.rejects(
    pull.readIssue({ owner: "johntango", repo: "Shipmates-Practice", number: 7 }),
    /pull request, not an issue/u,
  );
});

test("normalizes check, review, and workflow pages without raw response storage", async () => {
  const checkEndpoint = `repos/johntango/Shipmates-Practice/commits/${HEAD}/check-runs?per_page=100`;
  const reviewEndpoint = "repos/johntango/Shipmates-Practice/pulls/2/reviews?per_page=100";
  const runEndpoint = `repos/johntango/Shipmates-Practice/actions/runs?head_sha=${HEAD}&per_page=100`;
  const gateway = new GitHubReadGateway({
    client: new StubClient({
      [checkEndpoint]: [{ check_runs: [checkRun()] }],
      [reviewEndpoint]: [[{
        id: 20,
        state: "APPROVED",
        user: { login: "reviewer" },
        commit_id: HEAD,
        submitted_at: NOW.toISOString(),
        html_url: "https://github.com/example/review/20",
        body: "raw body must not be stored",
      }]],
      [runEndpoint]: [{ workflow_runs: [{
        id: 30,
        name: "test",
        head_sha: HEAD,
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/example/run/30",
        run_attempt: 1,
        logs_url: "raw URL must not be stored",
      }] }],
    }),
  });

  const checks = await gateway.listCheckRuns({ owner: "johntango", repo: "Shipmates-Practice", headSha: HEAD });
  const reviews = await gateway.listReviews({ owner: "johntango", repo: "Shipmates-Practice", number: 2 });
  const runs = await gateway.listWorkflowRuns({ owner: "johntango", repo: "Shipmates-Practice", headSha: HEAD });

  assert.equal(checks[0].conclusion, "success");
  assert.equal(reviews[0].body, undefined);
  assert.equal(runs[0].logs_url, undefined);
});

class StubClient {
  constructor(responses) {
    this.responses = responses;
    this.calls = [];
  }

  async get(request) {
    this.calls.push(request);
    if (!(request.endpoint in this.responses)) throw new GitHubReadError(`Unexpected endpoint ${request.endpoint}`);
    return structuredClone(this.responses[request.endpoint]);
  }
}

function pullRequest(number) {
  return {
    number,
    html_url: `https://github.com/johntango/Shipmates-Practice/pull/${number}`,
    state: "closed",
    draft: false,
    title: `Practice PR ${number}`,
    merged: true,
    mergeable: true,
    mergeable_state: "clean",
    base: {
      repo: { full_name: "johntango/Shipmates-Practice" },
      ref: "main",
      sha: BASE,
    },
    head: {
      repo: {
        full_name: "johntango/Shipmates-Practice",
        owner: { login: "johntango" },
      },
      ref: `task-${number}`,
      sha: HEAD,
    },
    updated_at: NOW.toISOString(),
  };
}

function checkRun({ headSha = HEAD } = {}) {
  return {
    id: 10,
    name: "test",
    head_sha: headSha,
    status: "completed",
    conclusion: "success",
    app: { slug: "github-actions" },
    html_url: "https://github.com/example/check/10",
    started_at: NOW.toISOString(),
    completed_at: NOW.toISOString(),
  };
}
