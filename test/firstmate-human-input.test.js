import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("surfaces validation and push approval gates in the Firstmate terminal", async () => {
  const source = await readFile(path.resolve("scripts/firstmate.js"), "utf8");
  assert.match(source, /local validation awaits human approval at/u);
  assert.match(source, /Review the validation details in the task dashboard/u);
  assert.match(source, /passed local validation and awaits explicit push approval/u);
  assert.match(source, /console\.error\(humanInputRequired/u);
});
