import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CodexWorkerError,
  CodexWorkerRuntime,
  validateWorkerReport,
} from "../src/adapters/codex-worker.js";

test("loads a structured report and thread id from durable Codex artifacts", async (t) => {
  const directory = await temporaryDirectory(t);
  const runtime = new CodexWorkerRuntime({
    environment: {
      PATH: process.env.PATH,
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      OPENAI_API_KEY: "secret",
    },
    runProcess: async ({ stdoutPath, stderrPath, args, env }) => {
      assert.ok(args.includes("--output-schema"));
      assert.ok(args.includes("--output-last-message"));
      assert.equal(env.GH_TOKEN, undefined);
      assert.equal(env.GITHUB_TOKEN, undefined);
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.match(env.GH_CONFIG_DIR, /gh-config$/u);
      assert.equal(env.GIT_TERMINAL_PROMPT, "0");
      const reportPath = args[args.indexOf("--output-last-message") + 1];
      await writeFile(
        stdoutPath,
        [
          JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
          JSON.stringify({ type: "turn.completed", usage: {} }),
          "",
        ].join("\n"),
      );
      await writeFile(stderrPath, "");
      await writeFile(reportPath, JSON.stringify(report()));
      return { exitCode: 0 };
    },
  });

  const result = await runtime.run({
    taskId: "codex-scout-001",
    workingDirectory: directory,
    prompt: "Return a report",
    schemaPath: path.resolve("schemas/codex-worker-report.schema.json"),
    artifactDirectory: path.join(directory, "artifacts"),
  });

  assert.equal(result.threadId, "thread-123");
  assert.equal(result.report.status, "completed");
  assert.equal(result.eventCount, 2);
});

test("refuses a missing completion event or mismatched task report", async (t) => {
  const directory = await temporaryDirectory(t);
  const artifactDirectory = path.join(directory, "artifacts");
  await mkdir(artifactDirectory);
  await writeFile(
    path.join(artifactDirectory, "codex-events.jsonl"),
    `${JSON.stringify({ type: "thread.started", thread_id: "thread-123" })}\n`,
  );
  await writeFile(
    path.join(artifactDirectory, "report.json"),
    JSON.stringify(report()),
  );
  const runtime = new CodexWorkerRuntime();

  await assert.rejects(
    runtime.loadCompleted({ taskId: "codex-scout-001", artifactDirectory }),
    /no completed turn/u,
  );
  assert.throws(
    () => validateWorkerReport(report(), "different-task"),
    CodexWorkerError,
  );
});

test("rejects extra report fields", () => {
  assert.throws(
    () =>
      validateWorkerReport(
        { ...report(), untrusted: "extra" },
        "codex-scout-001",
      ),
    /fields do not match/u,
  );
});

function report() {
  return {
    taskId: "codex-scout-001",
    status: "completed",
    summary: "Read-only inspection completed",
    branch: null,
    commit: null,
    files: [],
    tests: [],
    risks: [],
  };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
