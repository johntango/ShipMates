import assert from "node:assert/strict";
import test from "node:test";

import { HerdrProjectAgentObserver } from "../src/adapters/herdr-project-agent.js";

const project = {
  id: "project-a", name: "BallsA", status: "paused",
  executionPolicy: { worktreePath: "/worktrees/BallsA" },
};

test("creates and persistently reports one Herdr-visible project owner", async () => {
  const reports = [];
  const observer = new HerdrProjectAgentObserver({
    currentPaneId: "w1:p1",
    client: {
      list: async () => [],
      split: async ({ paneId, cwd }) => {
        assert.equal(paneId, "w1:p1"); assert.equal(cwd, "/worktrees/BallsA");
        return { paneId: "w1:p2" };
      },
      reportAgent: async (report) => reports.push(report),
    },
  });
  assert.equal(await observer.ensure(project), "w1:p2");
  assert.equal(reports[0].agent, "ShipMates Project: BallsA");
  assert.equal(reports[0].state, "idle");
  assert.equal(reports[0].customStatus, "paused");
  await observer.stage(project, { state: "working", status: "validating", message: "Running validation" });
  assert.equal(reports[1].customStatus, "validating");
  assert.equal(reports[1].source, "shipmates:project:project-a");
});

test("reports a resumed project as ready but idle until work is dispatched", async () => {
  const reports = [];
  const observer = new HerdrProjectAgentObserver({
    currentPaneId: "w1:p1",
    client: {
      list: async () => [{ paneId: "w1:p2", agent: "ShipMates Project: BallsA" }],
      reportAgent: async (report) => reports.push(report),
    },
  });
  await observer.ensure({ ...project, status: "approved" });
  assert.equal(reports[0].state, "idle");
  assert.equal(reports[0].customStatus, "ready");
  assert.equal(reports[0].message, "Project ready");
});
