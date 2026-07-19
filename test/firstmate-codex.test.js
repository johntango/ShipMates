import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FirstmateCodexConversation } from "../src/adapters/firstmate-codex.js";

test("continues one durable conversational Codex thread", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "firstmate-codex-"));
  const calls = [];
  const runProcess = async (call) => {
    calls.push(call);
    await writeFile(call.eventsPath, `${JSON.stringify({ type: "thread.started", thread_id: "thread-001" })}\n${JSON.stringify({ type: "turn.completed" })}\n`);
    const reportPath = call.args[call.args.indexOf("--output-last-message") + 1];
    await writeFile(reportPath, JSON.stringify({
      response: calls.length === 1 ? "I created a project plan." : "I can continue that plan.",
      action: calls.length === 1 ? "plan" : "answer",
      instruction: null,
      planTaskId: null,
      objective: calls.length === 1 ? "Build ShipMates" : null,
      tasks: calls.length === 1 ? [{ id: "one", title: "Foundation", description: "Build it", dependsOn: [] }] : [],
    }));
    return { exitCode: 0 };
  };
  const conversation = new FirstmateCodexConversation({ rootDir, runProcess });
  const input = { workingDirectory: process.cwd(), project: { name: "ShipMates" } };

  assert.equal((await conversation.turn({ ...input, message: "Plan this" })).action, "plan");
  assert.equal((await conversation.turn({ ...input, message: "Explain it" })).action, "answer");
  assert.ok(calls[1].args.includes("resume"));
  assert.ok(calls[1].args.includes("thread-001"));
});

test("returns an existing-task control action without an implementation instruction", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "firstmate-control-"));
  const runProcess = async (call) => {
    await writeFile(call.eventsPath, `${JSON.stringify({ type: "thread.started", thread_id: "thread-control" })}\n${JSON.stringify({ type: "turn.completed" })}\n`);
    const reportPath = call.args[call.args.indexOf("--output-last-message") + 1];
    await writeFile(reportPath, JSON.stringify({
      response: "I will apply the approval to the existing task.",
      action: "control", controlType: "accept_demo_warning", taskId: "task-existing123",
      instruction: null, planTaskId: null, objective: null, tasks: [],
    }));
    return { exitCode: 0 };
  };
  const decision = await new FirstmateCodexConversation({ rootDir, runProcess }).turn({
    message: "Apply my approval", workingDirectory: process.cwd(), project: {},
  });
  assert.equal(decision.action, "control");
  assert.equal(decision.taskId, "task-existing123");
});
