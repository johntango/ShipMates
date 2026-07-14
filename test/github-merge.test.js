import assert from "node:assert/strict";
import test from "node:test";

import { GitHubMergeGateway } from "../src/adapters/github-merge.js";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);

test("merge gateway can only request the approved exact-head squash merge", async () => {
  const calls = [];
  const gateway = new GitHubMergeGateway({
    clock: () => new Date("2026-07-14T16:00:00.000Z"),
    client: {
      async put(input) {
        calls.push(input);
        return { merged: true, sha: MERGE, message: "merged" };
      },
    },
  });

  const result = await gateway.mergeSquash({
    owner: "johntango",
    repo: "Shipmates-Practice",
    prNumber: 7,
    headSha: HEAD,
  });

  assert.deepEqual(calls, [{
    endpoint: "repos/johntango/Shipmates-Practice/pulls/7/merge",
    body: { sha: HEAD, merge_method: "squash" },
  }]);
  assert.equal(result.mergeCommitSha, MERGE);
  assert.equal(result.mergeMethod, "squash");
});

test("merge gateway rejects a response that does not confirm mutation", async () => {
  const gateway = new GitHubMergeGateway({
    client: { put: async () => ({ merged: false, sha: null }) },
  });

  await assert.rejects(
    gateway.mergeSquash({
      owner: "johntango",
      repo: "Shipmates-Practice",
      prNumber: 7,
      headSha: HEAD,
    }),
    /did not confirm/u,
  );
});
