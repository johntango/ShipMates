import assert from "node:assert/strict";
import test from "node:test";

import { runFirstmateLoop } from "../src/cli/firstmate-loop.js";

test("keeps accepting Firstmate requests until an explicit exit command", async () => {
  const answers = ["", "inspect package.json", "run the focused tests", "/exit"];
  const prompts = [];
  const requests = [];

  const result = await runFirstmateLoop({
    askMessage: async (prompt) => {
      prompts.push(prompt);
      return answers.shift();
    },
    runRequest: async (message) => requests.push(message),
  });

  assert.deepEqual(requests, ["inspect package.json", "run the focused tests"]);
  assert.equal(result.completed, 2);
  assert.equal(prompts.length, 4);
});

test("ends cleanly when interactive input closes", async () => {
  const result = await runFirstmateLoop({
    askMessage: async () => null,
    runRequest: async () => assert.fail("closed input must not dispatch"),
  });

  assert.equal(result.completed, 0);
});

test("collects an explicit multiline paste as one Firstmate request", async () => {
  const answers = ["/paste", "Build a dashboard that shows:", "- active work", "- completed work", "/send", "/exit"];
  const requests = [];

  const result = await runFirstmateLoop({
    askMessage: async () => answers.shift(),
    runRequest: async (message) => requests.push(message),
  });

  assert.deepEqual(requests, ["Build a dashboard that shows:\n- active work\n- completed work"]);
  assert.equal(result.completed, 1);
});

test("cancels multiline paste without dispatching partial lines", async () => {
  const answers = ["/paste", "Do not send this", "/cancel", "/exit"];
  const requests = [];
  await runFirstmateLoop({
    askMessage: async () => answers.shift(),
    runRequest: async (message) => requests.push(message),
  });
  assert.deepEqual(requests, []);
});
