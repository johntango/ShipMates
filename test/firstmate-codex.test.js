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
      requiredAuthority: null,
      objective: calls.length === 1 ? "Build ShipMates" : null,
      tasks: calls.length === 1 ? [{
        id: "one", title: "Foundation", description: "Build it",
        requiredAuthority: "local_write", dependsOn: [],
      }] : [],
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

test("capability planning ignores and preserves stale legacy conversation state", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "firstmate-capability-stateless-"));
  const calls = [];
  const runProcess = async (call) => {
    calls.push(call);
    const threadId = calls.length === 1 ? "thread-legacy" :
      calls.length === 2 ? "thread-capability" : "thread-legacy";
    await writeFile(call.eventsPath, `${JSON.stringify({ type: "thread.started", thread_id: threadId })}\n${JSON.stringify({ type: "turn.completed" })}\n`);
    const reportPath = call.args[call.args.indexOf("--output-last-message") + 1];
    await writeFile(reportPath, JSON.stringify(calls.length === 2 ? {
      response: "A bounded local implementation is ready.", action: "dispatch",
      controlType: null, taskId: null, instruction: "Build the page", planTaskId: null,
      requiredAuthority: "local_write", objective: null, tasks: [],
    } : {
      response: "Legacy conversation response.", action: "answer",
      controlType: null, taskId: null, instruction: null, planTaskId: null,
      requiredAuthority: null, objective: null, tasks: [],
    }));
    return { exitCode: 0 };
  };
  const conversation = new FirstmateCodexConversation({ rootDir, runProcess });
  const workingDirectory = process.cwd();

  await conversation.turn({ message: "Remember legacy work", workingDirectory, project: {} });
  const capability = await conversation.planCapability({
    message: "Build a local page", workingDirectory,
  });
  await conversation.turn({ message: "Continue legacy work", workingDirectory, project: {} });

  assert.equal(capability.requiredAuthority, "local_write");
  assert.equal(calls[1].args.includes("resume"), false);
  assert.doesNotMatch(calls[1].args.at(-1), /Project registry context|Continue the existing conversation/iu);
  assert.ok(calls[2].args.includes("resume"));
  assert.ok(calls[2].args.includes("thread-legacy"));
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
      requiredAuthority: null,
    }));
    return { exitCode: 0 };
  };
  const decision = await new FirstmateCodexConversation({ rootDir, runProcess }).turn({
    message: "Apply my approval", workingDirectory: process.cwd(), project: {},
  });
  assert.equal(decision.action, "control");
  assert.equal(decision.taskId, "task-existing123");
});

test("requires authority classification before returning a dispatch", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "firstmate-authority-"));
  const runProcess = async (call) => {
    await writeFile(call.eventsPath, `${JSON.stringify({ type: "thread.started", thread_id: "thread-authority" })}\n${JSON.stringify({ type: "turn.completed" })}\n`);
    const reportPath = call.args[call.args.indexOf("--output-last-message") + 1];
    await writeFile(reportPath, JSON.stringify({
      response: "I will inspect it.", action: "dispatch", controlType: null, taskId: null,
      instruction: "Inspect the repository", planTaskId: null, requiredAuthority: "read_only",
      objective: null, tasks: [],
    }));
    return { exitCode: 0 };
  };
  const decision = await new FirstmateCodexConversation({ rootDir, runProcess }).turn({
    message: "Inspect it", workingDirectory: process.cwd(), project: {},
  });
  assert.equal(decision.requiredAuthority, "read_only");
});
