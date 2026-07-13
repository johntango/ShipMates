import assert from "node:assert/strict";
import test from "node:test";

import { createFirstmateAgent } from "../src/workflows/firstmate.js";
import {
  createCodexScoutReplyTool,
  createCodexScoutTool,
} from "../src/tools/codex-scout-tool.js";

test("exposes one bounded scout tool to Firstmate without a handoff", async () => {
  const calls = [];
  const scoutTool = createCodexScoutTool({
    workflow: {
      async run(input) {
        calls.push(input);
        return snapshot(input);
      },
    },
  });
  const agent = createFirstmateAgent({ tools: [scoutTool] });

  assert.equal(agent.tools.length, 1);
  assert.equal(agent.tools[0].name, "codex_scout");
  assert.equal(agent.handoffs.length, 0);
  assert.equal(await scoutTool.needsApproval({ context: {} }, {}), false);

  const output = await scoutTool.invoke(
    { context: {} },
    JSON.stringify({
      taskId: "codex-mcp-001",
      workerId: "scout-001",
      brief: "Inspect exports",
    }),
  );
  assert.equal(calls.length, 1);
  assert.equal(output.threadId, "thread-123");
  assert.equal(output.verification.noMutation, true);
  assert.equal(output.ledger.state, "running");
});

test("rejects malformed tool input before the workflow runs", async () => {
  let called = false;
  const scoutTool = createCodexScoutTool({
    workflow: {
      async run() {
        called = true;
      },
    },
  });

  await assert.rejects(
    scoutTool.invoke(
      { context: {} },
      JSON.stringify({
        taskId: "INVALID",
        workerId: "scout-001",
        brief: "Inspect",
        sandbox: "workspace-write",
      }),
    ),
  );
  assert.equal(called, false);
});

test("exposes a bounded crash-safe scout reply tool", async () => {
  const calls = [];
  const replyTool = createCodexScoutReplyTool({
    workflow: {
      async reply(input) {
        calls.push(input);
        const value = snapshot(input);
        value.workers[0].replies = [{
          id: input.replyId,
          status: "completed",
          threadId: "thread-123",
          report: value.workers[0].report,
          verification: value.workers[0].verification,
        }];
        return value;
      },
    },
  });
  const agent = createFirstmateAgent({ tools: [replyTool] });
  assert.equal(agent.tools[0].name, "codex_scout_reply");
  assert.equal(agent.handoffs.length, 0);
  const output = await replyTool.invoke(
    { context: {} },
    JSON.stringify({
      taskId: "codex-mcp-001",
      workerId: "scout-001",
      replyId: "reply-001",
      prompt: "Clarify the risk",
    }),
  );
  assert.equal(calls.length, 1);
  assert.equal(output.replyId, "reply-001");
  assert.equal(output.threadId, "thread-123");
  assert.equal(output.verification.noMutation, true);
});

function snapshot({ taskId, workerId }) {
  return {
    id: taskId,
    state: "running",
    eventsCount: 12,
    lastEventId: "worker-report",
    workers: [
      {
        id: workerId,
        status: "reported",
        threadId: "thread-123",
        report: {
          taskId,
          status: "completed",
          summary: "Found exports",
          branch: null,
          commit: null,
          files: ["index.js"],
          tests: [],
          risks: [],
        },
        verification: {
          noMutation: true,
          headSha: "abc123",
          dirty: false,
        },
      },
    ],
  };
}
