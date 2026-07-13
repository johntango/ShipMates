import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CodexMcpError,
  CodexMcpRuntime,
  validateToolContract,
} from "../src/adapters/codex-mcp.js";

const schemaPath = fileURLToPath(
  new URL("../schemas/codex-worker-report.schema.json", import.meta.url),
);

test("runs a bounded Codex MCP scout and reloads its durable result", async (t) => {
  const directory = await temporaryDirectory(t);
  const calls = [];
  const optionsSeen = [];
  let closed = 0;
  const runtime = new CodexMcpRuntime({
    environment: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      OPENAI_API_KEY: "secret",
    },
    clock: () => new Date("2026-07-13T20:00:00.000Z"),
    serverFactory(options) {
      optionsSeen.push(options);
      return fakeServer({
        calls,
        onClose: () => {
          closed += 1;
        },
      });
    },
  });

  const result = await runtime.run({
    taskId: "codex-mcp-001",
    workingDirectory: directory,
    prompt: "Inspect exports",
    schemaPath,
    artifactDirectory: path.join(directory, "artifacts"),
    sandbox: "read-only",
  });

  assert.equal(result.threadId, "thread-123");
  assert.equal(result.report.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, "codex");
  assert.equal(calls[0].args.cwd, path.resolve(directory));
  assert.equal(calls[0].args.sandbox, "read-only");
  assert.equal(calls[0].args["approval-policy"], "never");
  assert.match(calls[0].args.prompt, /Output JSON Schema/u);
  assert.match(calls[0].args["developer-instructions"], /Never modify files/u);
  assert.equal(optionsSeen[0].env.GH_TOKEN, undefined);
  assert.equal(optionsSeen[0].env.GITHUB_TOKEN, undefined);
  assert.equal(optionsSeen[0].env.OPENAI_API_KEY, undefined);
  assert.match(optionsSeen[0].env.GH_CONFIG_DIR, /gh-config$/u);
  assert.equal(optionsSeen[0].env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(closed, 1);

  const loaded = await runtime.loadCompleted({
    taskId: "codex-mcp-001",
    artifactDirectory: path.join(directory, "artifacts"),
  });
  assert.deepEqual(loaded.report, result.report);
  assert.equal(loaded.threadId, result.threadId);
});

test("continues only the supplied thread through codex-reply", async (t) => {
  const directory = await temporaryDirectory(t);
  const calls = [];
  const runtime = new CodexMcpRuntime({
    serverFactory: () => fakeServer({ calls }),
  });

  const result = await runtime.reply({
    taskId: "codex-mcp-001",
    replyId: "reply-001",
    threadId: "thread-123",
    prompt: "Clarify the risk",
    leaseHeadSha: "abc123",
    promptSha256: "a".repeat(64),
    schemaPath,
    artifactDirectory: path.join(directory, "artifacts"),
  });

  assert.equal(result.threadId, "thread-123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, "codex-reply");
  assert.deepEqual(Object.keys(calls[0].args).sort(), ["prompt", "threadId"]);
  assert.equal(calls[0].args.threadId, "thread-123");
  assert.match(calls[0].args.prompt, /read-only/u);

  const loaded = await runtime.loadCompletedReply({
    taskId: "codex-mcp-001",
    replyId: "reply-001",
    threadId: "thread-123",
    leaseHeadSha: "abc123",
    promptSha256: "a".repeat(64),
    artifactDirectory: path.join(directory, "artifacts"),
  });
  assert.deepEqual(loaded.report, result.report);
});

test("fails closed on tool drift, unsafe sandbox, and non-JSON output", async (t) => {
  const directory = await temporaryDirectory(t);
  assert.throws(
    () => validateToolContract([{ name: "codex", inputSchema: {} }]),
    /tool contract changed/u,
  );

  const runtime = new CodexMcpRuntime({
    serverFactory: () => fakeServer({ content: "```json\n{}\n```" }),
  });
  await assert.rejects(
    runtime.run({
      taskId: "codex-mcp-001",
      workingDirectory: directory,
      prompt: "Inspect",
      schemaPath,
      artifactDirectory: path.join(directory, "artifacts"),
      sandbox: "workspace-write",
    }),
    /must be read-only/u,
  );
  await assert.rejects(
    runtime.run({
      taskId: "codex-mcp-001",
      workingDirectory: directory,
      prompt: "Inspect",
      schemaPath,
      artifactDirectory: path.join(directory, "artifacts"),
    }),
    /not strict JSON/u,
  );
});

function fakeServer({ calls = [], content, onClose = () => {} } = {}) {
  return {
    async connect() {},
    async close() {
      onClose();
    },
    async listTools() {
      return toolContract();
    },
    async callToolResult(toolName, args) {
      calls.push({ toolName, args });
      return {
        content: [{ type: "text", text: "structured result follows" }],
        structuredContent: {
          threadId: "thread-123",
          content: content ?? JSON.stringify(report()),
        },
        isError: false,
      };
    },
  };
}

function toolContract() {
  return [
    {
      name: "codex",
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          [
            "prompt",
            "cwd",
            "sandbox",
            "approval-policy",
            "developer-instructions",
          ].map((name) => [name, { type: "string" }]),
        ),
        required: ["prompt"],
      },
    },
    {
      name: "codex-reply",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          threadId: { type: "string" },
        },
        required: ["prompt"],
      },
    },
  ];
}

function report() {
  return {
    taskId: "codex-mcp-001",
    status: "completed",
    summary: "Read-only inspection completed",
    branch: null,
    commit: null,
    files: ["index.js"],
    tests: [],
    risks: [],
  };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-mcp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
