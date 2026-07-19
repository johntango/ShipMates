import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DashboardLavishReview } from "../src/dashboard/lavish-review.js";

test("writes a safe Lavish fixture using the real Bootstrap dashboard assets", async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "dashboard-review-"));
  const review = new DashboardLavishReview({ stateRoot });

  const target = await review.write();
  const html = await readFile(target, "utf8");
  const state = await readFile(path.join(path.dirname(target), "assets", "review-state.js"), "utf8");
  const renderer = await readFile(path.join(path.dirname(target), "assets", "dashboard.js"), "utf8");

  assert.equal(target, path.join(stateRoot, "reviews", "dashboard", "index.html"));
  assert.match(html, /vendor\/bootstrap\.min\.css/u);
  assert.match(html, /assets\/review-state\.js/u);
  assert.match(state, /task-review-active/u);
  assert.match(state, /recovery_required/u);
  assert.match(renderer, /Visual review only/u);
  assert.doesNotMatch(html, /\/api\//u);
});
