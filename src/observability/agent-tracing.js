import {
  appendFile,
  mkdir,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  addTraceProcessor,
  setTraceProcessors,
} from "@openai/agents";

export const TRACE_MODES = Object.freeze(["off", "local", "platform", "dual"]);
export const DEFAULT_TRACE_RETENTION_DAYS = 3;
export const DEFAULT_TRACE_MAX_RUNS = 20;

export function tracingConfigFromEnv(environment = process.env) {
  const legacy = parseLegacyBoolean(environment.SHIPMATES_FIRSTMATE_TRACING);
  const mode = environment.SHIPMATES_TRACING === undefined
    ? (legacy ? "platform" : "off")
    : parseTraceMode(environment.SHIPMATES_TRACING);
  return Object.freeze({
    mode,
    retentionDays: parseBoundedInteger(
      "SHIPMATES_TRACE_RETENTION_DAYS",
      environment.SHIPMATES_TRACE_RETENTION_DAYS,
      DEFAULT_TRACE_RETENTION_DAYS,
      1,
      3_650,
    ),
    maxRuns: parseBoundedInteger(
      "SHIPMATES_TRACE_MAX_RUNS",
      environment.SHIPMATES_TRACE_MAX_RUNS,
      DEFAULT_TRACE_MAX_RUNS,
      1,
      10_000,
    ),
  });
}

export function configureAgentTracing({
  config,
  stateRoot,
  processorFactory = (options) => new LocalTraceProcessor(options),
} = {}) {
  if (!config || !TRACE_MODES.includes(config.mode)) {
    throw new TypeError("configureAgentTracing requires a valid tracing config");
  }
  if (config.mode === "local" || config.mode === "dual") {
    const processor = processorFactory({
      directory: path.join(path.resolve(stateRoot), "traces"),
      retentionDays: config.retentionDays,
      maxRuns: config.maxRuns,
    });
    if (config.mode === "local") setTraceProcessors([processor]);
    else addTraceProcessor(processor);
  }
  return config;
}

export function traceRunOptions(config, {
  workflowName,
  groupId,
  traceId,
  metadata,
} = {}) {
  if (!config || !TRACE_MODES.includes(config.mode)) {
    throw new TypeError("traceRunOptions requires a valid tracing config");
  }
  const enabled = config.mode !== "off";
  return {
    tracingDisabled: !enabled,
    traceIncludeSensitiveData: false,
    workflowName,
    groupId,
    ...(enabled && traceId ? { traceId } : {}),
    ...(enabled && metadata ? { traceMetadata: metadata } : {}),
  };
}

export class LocalTraceProcessor {
  constructor({ directory, retentionDays, maxRuns, clock = () => new Date() } = {}) {
    if (!directory || !Number.isSafeInteger(retentionDays) || !Number.isSafeInteger(maxRuns)) {
      throw new TypeError("LocalTraceProcessor requires directory and integer retention limits");
    }
    this.directory = path.resolve(directory);
    this.retentionDays = retentionDays;
    this.maxRuns = maxRuns;
    this.clock = clock;
    this.pending = Promise.resolve();
  }

  onTraceStart(trace) {
    return this.#enqueue(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await appendFile(this.#tracePath(trace.traceId), `${JSON.stringify({
        event: "trace_start",
        at: this.clock().toISOString(),
        traceId: trace.traceId,
        name: trace.name,
        groupId: trace.groupId,
      })}\n`, { encoding: "utf8", mode: 0o600 });
    });
  }

  onTraceEnd(trace) {
    return this.#enqueue(async () => {
      await appendFile(this.#tracePath(trace.traceId), `${JSON.stringify({
        event: "trace_end",
        at: this.clock().toISOString(),
        traceId: trace.traceId,
      })}\n`, { encoding: "utf8", mode: 0o600 });
      await this.#prune();
    });
  }

  onSpanStart(span) {
    return this.#span("span_start", span);
  }

  onSpanEnd(span) {
    return this.#span("span_end", span);
  }

  forceFlush() {
    return this.pending;
  }

  async shutdown() {
    await this.pending;
  }

  #span(event, span) {
    return this.#enqueue(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const data = span.spanData || {};
      await appendFile(this.#tracePath(span.traceId), `${JSON.stringify({
        event,
        at: this.clock().toISOString(),
        traceId: span.traceId,
        spanId: span.spanId,
        parentId: span.parentId,
        type: data.type || "unknown",
        name: safeSpanName(data),
        model: data.type === "generation" ? data.model || null : null,
        usage: data.type === "generation" ? safeUsage(data.usage) : null,
        error: Boolean(span.error),
      })}\n`, { encoding: "utf8", mode: 0o600 });
    });
  }

  #enqueue(operation) {
    this.pending = this.pending.then(operation, operation);
    return this.pending;
  }

  #tracePath(traceId) {
    const safe = String(traceId).replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
    return path.join(this.directory, `${safe}.jsonl`);
  }

  async #prune() {
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".jsonl"));
    const entries = await Promise.all(names.map(async (name) => ({
      name,
      modifiedAt: (await stat(path.join(this.directory, name))).mtimeMs,
    })));
    const cutoff = this.clock().getTime() - this.retentionDays * 86_400_000;
    const recent = entries.filter(({ modifiedAt }) => modifiedAt >= cutoff)
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    const removals = [
      ...entries.filter(({ modifiedAt }) => modifiedAt < cutoff),
      ...recent.slice(this.maxRuns),
    ];
    await Promise.all(removals.map(({ name }) =>
      unlink(path.join(this.directory, name)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      })));
  }
}

function parseTraceMode(value) {
  const mode = String(value).trim().toLowerCase();
  if (!TRACE_MODES.includes(mode)) {
    throw new TypeError(`SHIPMATES_TRACING must be one of: ${TRACE_MODES.join(", ")}`);
  }
  return mode;
}

function parseLegacyBoolean(value) {
  if (value === undefined || value === "") return false;
  if (/^(?:1|true|yes|on)$/iu.test(value)) return true;
  if (/^(?:0|false|no|off)$/iu.test(value)) return false;
  throw new TypeError("SHIPMATES_FIRSTMATE_TRACING must be a boolean");
}

function parseBoundedInteger(name, value, fallback, minimum, maximum) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/u.test(value)) throw new TypeError(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function safeSpanName(data) {
  if (new Set(["agent", "function", "custom", "guardrail"]).has(data.type)) {
    return typeof data.name === "string" ? data.name : null;
  }
  if (data.type === "handoff") return `${data.from_agent || "unknown"}->${data.to_agent || "unknown"}`;
  return null;
}

function safeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    inputTokens: Number.isSafeInteger(usage.input_tokens) ? usage.input_tokens : 0,
    outputTokens: Number.isSafeInteger(usage.output_tokens) ? usage.output_tokens : 0,
  };
}
