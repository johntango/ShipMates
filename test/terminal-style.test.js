import assert from "node:assert/strict";
import test from "node:test";

import { appearsToRequireHumanInput, humanInputRequired } from "../src/cli/terminal-style.js";

test("renders human decisions with a clear red terminal flag", () => {
  assert.equal(
    humanInputRequired("Approve the release?", { color: true }),
    "\u001b[31;1mHUMAN INPUT REQUIRED: Approve the release?\u001b[0m",
  );
  assert.equal(
    humanInputRequired("Approve the release?", { color: false }),
    "HUMAN INPUT REQUIRED: Approve the release?",
  );
});

test("distinguishes questions and decisions from ordinary status", () => {
  assert.equal(appearsToRequireHumanInput("Should I retry BallsA?"), true);
  assert.equal(appearsToRequireHumanInput("Please choose a deployment target."), true);
  assert.equal(appearsToRequireHumanInput("BallsA advanced to interaction."), false);
});
