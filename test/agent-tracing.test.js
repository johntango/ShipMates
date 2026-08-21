import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_TRACE_MAX_RUNS,
  DEFAULT_TRACE_RETENTION_DAYS,
  LocalTraceProcessor,
  traceRunOptions,
  tracingConfigFromEnv,
} from "../src/observability/agent-tracing.js";

test("keeps tracing off by default with bounded local retention defaults", () => {
  assert.deepEqual(tracingConfigFromEnv({}), {
    mode: "off",
    retentionDays: DEFAULT_TRACE_RETENTION_DAYS,
    maxRuns: DEFAULT_TRACE_MAX_RUNS,
  });
  assert.deepEqual(tracingConfigFromEnv({
    SHIPMATES_TRACING: "local",
    SHIPMATES_TRACE_RETENTION_DAYS: "3",
    SHIPMATES_TRACE_MAX_RUNS: "20",
  }), { mode: "local", retentionDays: 3, maxRuns: 20 });
});

test("supports the legacy platform flag and rejects unsafe configuration", () => {
  assert.equal(tracingConfigFromEnv({ SHIPMATES_FIRSTMATE_TRACING: "true" }).mode,
    "platform");
  assert.throws(() => tracingConfigFromEnv({ SHIPMATES_TRACING: "verbose" }),
    /must be one of/u);
  assert.throws(() => tracingConfigFromEnv({ SHIPMATES_TRACE_RETENTION_DAYS: "0" }),
    /between 1 and 3650/u);
  assert.throws(() => tracingConfigFromEnv({ SHIPMATES_TRACE_MAX_RUNS: "many" }),
    /must be an integer/u);
});

test("always excludes sensitive trace data", () => {
  assert.deepEqual(traceRunOptions({ mode: "local" }, {
    workflowName: "ShipMates test",
    groupId: "task-1",
    traceId: `trace_${"a".repeat(32)}`,
    metadata: { component: "firstmate" },
  }), {
    tracingDisabled: false,
    traceIncludeSensitiveData: false,
    workflowName: "ShipMates test",
    groupId: "task-1",
    traceId: `trace_${"a".repeat(32)}`,
    traceMetadata: { component: "firstmate" },
  });
});

test("writes structural local traces without payloads and prunes old or excess runs", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "shipmates-traces-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = new Date("2026-07-31T12:00:00.000Z");
  const processor = new LocalTraceProcessor({
    directory, retentionDays: 3, maxRuns: 2, clock: () => now,
  });
  await processor.onTraceStart({
    traceId: "trace_current", name: "ShipMates test", groupId: "task-1",
    metadata: { rawPrompt: "do not store" },
  });
  await processor.onSpanEnd({
    traceId: "trace_current", spanId: "span-1", parentId: null,
    spanData: {
      type: "function", name: "bounded_tool", input: "secret input", output: "secret output",
    },
    error: { message: "secret error" },
  });
  await processor.onTraceEnd({ traceId: "trace_current" });
  const content = await readFile(path.join(directory, "trace_current.jsonl"), "utf8");
  assert.match(content, /bounded_tool/u);
  assert.doesNotMatch(content, /secret|rawPrompt/u);

  await writeFile(path.join(directory, "trace_old.jsonl"), "old\n");
  const old = new Date(now.getTime() - 4 * 86_400_000);
  await utimes(path.join(directory, "trace_old.jsonl"), old, old);
  await writeFile(path.join(directory, "trace_extra.jsonl"), "extra\n");
  const recent = new Date(now.getTime() - 1_000);
  await utimes(path.join(directory, "trace_extra.jsonl"), recent, recent);
  await processor.onTraceEnd({ traceId: "trace_new" });

  assert.deepEqual((await readdir(directory)).sort(), [
    "trace_current.jsonl", "trace_new.jsonl",
  ]);
});
