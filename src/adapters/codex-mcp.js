import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { MCPServerStdio } from "@openai/agents";

import { validateWorkerReport } from "./codex-worker.js";

const expectedTools = Object.freeze(["codex", "codex-reply"]);

export class CodexMcpRuntime {
  constructor({
    binary = process.env.CODEX_BIN || "codex",
    environment = process.env,
    serverFactory = (options) => new MCPServerStdio(options),
    clock = () => new Date(),
    timeoutSeconds = 3_600,
  } = {}) {
    this.backend = "codex-mcp";
    this.binary = binary;
    this.environment = environment;
    this.serverFactory = serverFactory;
    this.clock = clock;
    this.timeoutSeconds = timeoutSeconds;
  }

  async run({
    taskId,
    workingDirectory,
    prompt,
    schemaPath,
    artifactDirectory,
    sandbox = "read-only",
  }) {
    requireInputs({
      taskId,
      workingDirectory,
      prompt,
      schemaPath,
      artifactDirectory,
      sandbox,
    });
    if (sandbox !== "read-only") {
      throw new CodexMcpError("Codex MCP scout sandbox must be read-only");
    }
    const schema = await loadSchema(schemaPath);
    const args = {
      prompt: `${prompt}\nOutput JSON Schema:\n${JSON.stringify(schema)}`,
      cwd: path.resolve(workingDirectory),
      sandbox: "read-only",
      "approval-policy": "never",
      "developer-instructions": developerInstructions(taskId),
    };
    const result = await this.#call({
      toolName: "codex",
      args,
      artifactDirectory,
    });
    const completed = normalizeToolResult(result, taskId, "codex");
    await writeArtifact(artifactPath(artifactDirectory), {
      schemaVersion: 1,
      taskId,
      protocol: "mcp",
      tool: "codex",
      threadId: completed.threadId,
      report: completed.report,
      completedAt: this.clock().toISOString(),
    });
    return {
      threadId: completed.threadId,
      report: completed.report,
      eventCount: 1,
      artifacts: { result: artifactPath(artifactDirectory) },
    };
  }

  async reply({
    taskId,
    replyId,
    threadId,
    prompt,
    leaseHeadSha,
    promptSha256,
    schemaPath,
    artifactDirectory,
  }) {
    requireInputs({
      taskId, replyId, threadId, prompt, leaseHeadSha, promptSha256,
      schemaPath, artifactDirectory,
    });
    requireIdentifier("replyId", replyId);
    const schema = await loadSchema(schemaPath);
    const result = await this.#call({
      toolName: "codex-reply",
      args: {
        threadId,
        prompt: [
          "Continue only the existing read-only ShipMates scout task.",
          "Do not modify files, access GitHub, or address the human.",
          prompt,
          `Return only JSON matching this schema: ${JSON.stringify(schema)}`,
        ].join("\n"),
      },
      artifactDirectory,
    });
    const completed = normalizeToolResult(result, taskId, "codex-reply");
    if (completed.threadId !== threadId) {
      throw new CodexMcpError("Codex MCP reply changed the durable thread ID");
    }
    await writeArtifact(replyArtifactPath(artifactDirectory, replyId), {
      schemaVersion: 1,
      taskId,
      replyId,
      protocol: "mcp",
      tool: "codex-reply",
      threadId: completed.threadId,
      leaseHeadSha,
      sandbox: "read-only",
      promptSha256,
      report: completed.report,
      completedAt: this.clock().toISOString(),
    });
    return {
      threadId: completed.threadId,
      report: completed.report,
      eventCount: 1,
      artifacts: { result: replyArtifactPath(artifactDirectory, replyId) },
    };
  }

  async loadCompletedReply({
    taskId, replyId, threadId, leaseHeadSha, promptSha256, artifactDirectory,
  }) {
    requireInputs({
      taskId, replyId, threadId, leaseHeadSha, promptSha256, artifactDirectory,
    });
    requireIdentifier("replyId", replyId);
    let artifact;
    try {
      artifact = JSON.parse(
        await readFile(replyArtifactPath(artifactDirectory, replyId), "utf8"),
      );
    } catch (cause) {
      throw new CodexMcpError("Codex MCP reply artifact is missing or invalid", {
        cause,
      });
    }
    const expectedKeys = [
      "completedAt", "leaseHeadSha", "promptSha256", "protocol", "replyId",
      "report", "sandbox", "schemaVersion", "taskId", "threadId", "tool",
    ];
    if (
      !artifact || typeof artifact !== "object" || Array.isArray(artifact) ||
      Object.keys(artifact).sort().join(",") !== expectedKeys.sort().join(",") ||
      artifact.schemaVersion !== 1 || artifact.taskId !== taskId ||
      artifact.replyId !== replyId || artifact.protocol !== "mcp" ||
      artifact.tool !== "codex-reply" || artifact.threadId !== threadId ||
      artifact.leaseHeadSha !== leaseHeadSha || artifact.sandbox !== "read-only" ||
      artifact.promptSha256 !== promptSha256 ||
      Number.isNaN(Date.parse(artifact.completedAt))
    ) throw new CodexMcpError("Codex MCP reply artifact identity is invalid");
    validateWorkerReport(artifact.report, taskId);
    return {
      threadId: artifact.threadId,
      report: artifact.report,
      eventCount: 1,
      artifacts: { result: replyArtifactPath(artifactDirectory, replyId) },
    };
  }

  async loadCompleted({ taskId, artifactDirectory }) {
    requireInputs({ taskId, artifactDirectory });
    let artifact;
    try {
      artifact = JSON.parse(await readFile(artifactPath(artifactDirectory), "utf8"));
    } catch (cause) {
      throw new CodexMcpError("Codex MCP result artifact is missing or invalid", {
        cause,
      });
    }
    const expectedKeys = [
      "completedAt",
      "protocol",
      "report",
      "schemaVersion",
      "taskId",
      "threadId",
      "tool",
    ];
    if (
      !artifact ||
      typeof artifact !== "object" ||
      Array.isArray(artifact) ||
      Object.keys(artifact).sort().join(",") !== expectedKeys.sort().join(",") ||
      artifact.schemaVersion !== 1 ||
      artifact.taskId !== taskId ||
      artifact.protocol !== "mcp" ||
      artifact.tool !== "codex" ||
      !isNonEmpty(artifact.threadId) ||
      Number.isNaN(Date.parse(artifact.completedAt))
    ) {
      throw new CodexMcpError("Codex MCP result artifact identity is invalid");
    }
    validateWorkerReport(artifact.report, taskId);
    return {
      threadId: artifact.threadId,
      report: artifact.report,
      eventCount: 1,
      artifacts: { result: artifactPath(artifactDirectory) },
    };
  }

  async #call({ toolName, args, artifactDirectory }) {
    const githubConfigDirectory = path.join(
      path.resolve(artifactDirectory),
      "gh-config",
    );
    await mkdir(githubConfigDirectory, { recursive: true, mode: 0o700 });
    const server = this.serverFactory({
      name: "ShipMates Codex MCP",
      command: this.binary,
      args: ["mcp-server"],
      env: workerEnvironment(this.environment, githubConfigDirectory),
      cacheToolsList: true,
      clientSessionTimeoutSeconds: this.timeoutSeconds,
      useStructuredContent: true,
      errorFunction: null,
    });
    if (!server || typeof server.connect !== "function") {
      throw new CodexMcpError("Codex MCP server factory returned an invalid server");
    }
    await server.connect();
    try {
      validateToolContract(await server.listTools());
      if (typeof server.callToolResult === "function") {
        return await server.callToolResult(toolName, args);
      }
      const content = await server.callTool(toolName, args);
      return {
        content: [...content],
        structuredContent: content.structuredContent,
        isError: content.isError,
      };
    } finally {
      await server.close();
    }
  }
}

export class CodexMcpError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "CodexMcpError";
  }
}

export function validateToolContract(tools) {
  if (!Array.isArray(tools)) {
    throw new CodexMcpError("Codex MCP tools/list result must be an array");
  }
  const names = tools.map(({ name }) => name).sort();
  if (names.join(",") !== [...expectedTools].sort().join(",")) {
    throw new CodexMcpError(
      `Codex MCP tool contract changed: ${names.join(",") || "none"}`,
    );
  }
  const start = tools.find(({ name }) => name === "codex")?.inputSchema;
  const reply = tools.find(({ name }) => name === "codex-reply")?.inputSchema;
  for (const field of [
    "prompt",
    "cwd",
    "sandbox",
    "approval-policy",
    "developer-instructions",
  ]) {
    if (!start?.properties?.[field]) {
      throw new CodexMcpError(`Codex MCP codex tool lacks ${field}`);
    }
  }
  for (const field of ["prompt", "threadId"]) {
    if (!reply?.properties?.[field]) {
      throw new CodexMcpError(`Codex MCP codex-reply tool lacks ${field}`);
    }
  }
}

function normalizeToolResult(result, taskId, toolName) {
  if (!result || typeof result !== "object" || result.isError === true) {
    throw new CodexMcpError(`Codex MCP ${toolName} returned an error`);
  }
  const structured = result.structuredContent;
  if (
    !structured ||
    typeof structured !== "object" ||
    Array.isArray(structured) ||
    !isNonEmpty(structured.threadId) ||
    !isNonEmpty(structured.content)
  ) {
    throw new CodexMcpError(
      `Codex MCP ${toolName} result lacks structured thread content`,
    );
  }
  let report;
  try {
    report = JSON.parse(structured.content);
  } catch (cause) {
    throw new CodexMcpError("Codex MCP content is not strict JSON", { cause });
  }
  validateWorkerReport(report, taskId);
  return { threadId: structured.threadId, report };
}

async function loadSchema(schemaPath) {
  let schema;
  try {
    schema = JSON.parse(await readFile(path.resolve(schemaPath), "utf8"));
  } catch (cause) {
    throw new CodexMcpError("Codex MCP output schema is missing or invalid", {
      cause,
    });
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new CodexMcpError("Codex MCP output schema must be an object");
  }
  return schema;
}

function developerInstructions(taskId) {
  return [
    `You are a read-only ShipMates scout for task ${taskId}.`,
    "The MCP caller fixes the sandbox, working directory, and approval policy.",
    "Never modify files, create commits, access GitHub, or address the human.",
    "Return only the requested structured JSON report.",
  ].join(" ");
}

function workerEnvironment(environment, githubConfigDirectory) {
  const result = { ...environment };
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY"]) {
    delete result[name];
  }
  return {
    ...result,
    GH_CONFIG_DIR: githubConfigDirectory,
    GIT_ASKPASS: "/usr/bin/false",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function writeArtifact(targetPath, value) {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function artifactPath(artifactDirectory) {
  return path.join(path.resolve(artifactDirectory), "codex-mcp-result.json");
}

function replyArtifactPath(artifactDirectory, replyId) {
  return path.join(
    path.resolve(artifactDirectory),
    "replies",
    `${replyId}.json`,
  );
}

function requireInputs(values) {
  for (const [label, value] of Object.entries(values)) {
    if (!isNonEmpty(value)) {
      throw new TypeError(`${label} must be a non-empty string`);
    }
  }
}

function requireIdentifier(label, value) {
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(value)) {
    throw new TypeError(`${label} must be a safe 3-64 character identifier`);
  }
}

function isNonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}
