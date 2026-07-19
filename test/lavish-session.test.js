import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  LavishSessionManager,
  parseLavishActions,
  parseLavishDecisions,
} from "../src/adapters/lavish-session.js";

test("reopens and reattaches an existing dashboard session after restart", async () => {
  const calls = [];
  const manager = new LavishSessionManager({
    nodePath: "/node",
    cliPath: "/lavish.mjs",
    spawnProcess: (_file, args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      if (calls.length === 1) queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  await manager.open({
    dashboardPath: "/dashboard.html",
    taskId: "task-001",
    onAction: async () => "done",
    reopen: true,
  });

  assert.deepEqual(calls[0], ["/lavish.mjs", "/dashboard.html", "--reopen"]);
  assert.deepEqual(calls[1], ["/lavish.mjs", "poll", "/dashboard.html"]);
});

test("parses allowlisted Lavish actions bound to the expected task", () => {
  const output = `prompts[3]{tag,prompt}:
  shipmates-action,shipmates-action:v1:show_files:task-001
  shipmates-action,shipmates-action:v1:show_status:task-other
  shipmates-action,shipmates-action:v1:approve_push:task-001`;

  assert.deepEqual(parseLavishActions(output, "task-001"), [{
    schemaVersion: 1,
    action: "show_files",
    taskId: "task-001",
  }]);
});

test("parses only allowlisted decisions for the expected task", () => {
  const output = `
    shipmates-decision:v1:review_files:task-001
    shipmates-decision:v1:no_action:task-other
    shipmates-decision:v1:approve_push:task-001`;

  assert.deepEqual(parseLavishDecisions(output, "task-001"), [{
    schemaVersion: 1,
    decision: "review_files",
    taskId: "task-001",
  }]);
});

test("parses a task-bound local delivery decision", () => {
  const output = "shipmates-decision:v1:deliver_changes:task-001";

  assert.deepEqual(parseLavishDecisions(output, "task-001"), [{
    schemaVersion: 1,
    decision: "deliver_changes",
    taskId: "task-001",
  }]);
});

test("parses a task-bound HTML review file index", () => {
  const output = "shipmates-action:v1:review_file_2:task-001";

  assert.deepEqual(parseLavishActions(output, "task-001"), [{
    schemaVersion: 1,
    action: "review_file",
    fileIndex: 2,
    taskId: "task-001",
  }]);
});
