import assert from "node:assert/strict";
import test from "node:test";

import {
  createFirstmateId,
  discoverFirstmateContext,
  parseGitHubRepository,
} from "../src/cli/firstmate-context.js";

test("creates valid collision-resistant ledger identifiers", () => {
  const id = createFirstmateId("task", {
    uuidFactory: () => "01234567-89ab-cdef-0123-456789abcdef",
  });
  assert.equal(id, "task-0123456789abcdef0123");
  assert.match(id, /^[a-z0-9][a-z0-9._-]{2,63}$/u);
});

test("parses HTTPS and SSH GitHub origin remotes", () => {
  assert.equal(
    parseGitHubRepository("https://github.com/johntango/ShipMates.git\n"),
    "johntango/ShipMates",
  );
  assert.equal(
    parseGitHubRepository("git@github.com:johntango/ShipMates.git"),
    "johntango/ShipMates",
  );
});

test("discovers repository identity and exact base SHA", async () => {
  const calls = [];
  const result = await discoverFirstmateContext({
    cwd: "/tmp/example",
    runGit: async (args, cwd) => {
      calls.push({ args, cwd });
      return args[0] === "remote"
        ? "https://github.com/johntango/ShipMates.git\n"
        : "abc123\n";
    },
  });
  assert.deepEqual(result, {
    repoPath: "/tmp/example",
    repo: "johntango/ShipMates",
    baseSha: "abc123",
  });
  assert.equal(calls.length, 2);
});
