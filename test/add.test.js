import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { add } from "../src/core/add.js";

test("adds two numbers", () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-4, 1.5), -2.5);
  assert.equal(add(0, 0), 0);
});

test("rejects operands that are not finite numbers", () => {
  assert.throws(() => add("2", 3), /finite numbers/u);
  assert.throws(() => add(Number.NaN, 3), /finite numbers/u);
  assert.throws(() => add(Infinity, 3), /finite numbers/u);
});

test("command line program prints the sum", () => {
  const result = runAdd("2.5", "-1");

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "1.5\n");
  assert.equal(result.stderr, "");
});

test("command line program rejects missing or invalid operands", () => {
  const missing = runAdd("2");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Usage:/u);

  const invalid = runAdd("two", "3");
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /finite numbers/u);
});

function runAdd(...operands) {
  return spawnSync(process.execPath, ["scripts/add.js", ...operands], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
}
