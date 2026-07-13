import { spawn } from "node:child_process";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

export class CodexWorkerRuntime {
  constructor({
    binary = process.env.CODEX_BIN || "codex",
    runProcess = runSpawnedProcess,
    environment = process.env,
  } = {}) {
    this.binary = binary;
    this.runProcess = runProcess;
    this.environment = environment;
  }

  async run({
    taskId,
    workingDirectory,
    prompt,
    schemaPath,
    artifactDirectory,
    sandbox = "read-only",
  }) {
    for (const [label, value] of Object.entries({
      taskId,
      workingDirectory,
      prompt,
      schemaPath,
      artifactDirectory,
      sandbox,
    })) {
      requireNonEmpty(label, value);
    }
    const paths = artifactPaths(artifactDirectory);
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    const githubConfigDirectory = path.join(paths.directory, "gh-config");
    await mkdir(githubConfigDirectory, { recursive: true, mode: 0o700 });
    await Promise.all(
      [paths.events, paths.stderr, paths.report].map((target) =>
        unlink(target).catch((error) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }),
      ),
    );

    const args = [
      "exec",
      "--ignore-user-config",
      "--sandbox",
      sandbox,
      "--color",
      "never",
      "--json",
      "--output-schema",
      path.resolve(schemaPath),
      "--output-last-message",
      paths.report,
      "--cd",
      path.resolve(workingDirectory),
      prompt,
    ];
    const result = await this.runProcess({
      file: this.binary,
      args,
      cwd: path.resolve(workingDirectory),
      env: workerEnvironment(this.environment, githubConfigDirectory),
      stdoutPath: paths.events,
      stderrPath: paths.stderr,
    });
    if (result.exitCode !== 0) {
      const stderr = await readFile(paths.stderr, "utf8").catch(() => "");
      throw new CodexWorkerError(
        `Codex exited with ${result.exitCode}: ${stderr.trim() || "no error output"}`,
      );
    }
    return this.loadCompleted({ taskId, artifactDirectory });
  }

  async loadCompleted({ taskId, artifactDirectory }) {
    requireNonEmpty("taskId", taskId);
    const paths = artifactPaths(artifactDirectory);
    const [eventText, reportText] = await Promise.all([
      readFile(paths.events, "utf8"),
      readFile(paths.report, "utf8"),
    ]);
    const events = parseJsonLines(eventText, paths.events);
    const threadEvents = events.filter((event) => event.type === "thread.started");
    if (threadEvents.length !== 1 || !isNonEmpty(threadEvents[0].thread_id)) {
      throw new CodexWorkerError(
        `Expected one Codex thread.started event, found ${threadEvents.length}`,
      );
    }
    if (!events.some((event) => event.type === "turn.completed")) {
      throw new CodexWorkerError("Codex event stream has no completed turn");
    }

    let report;
    try {
      report = JSON.parse(reportText);
    } catch (cause) {
      throw new CodexWorkerError("Codex last-message report is not valid JSON", {
        cause,
      });
    }
    validateWorkerReport(report, taskId);
    return Object.freeze({
      threadId: threadEvents[0].thread_id,
      report,
      eventCount: events.length,
      artifacts: Object.freeze(paths),
    });
  }
}

export class CodexWorkerError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "CodexWorkerError";
  }
}

export function validateWorkerReport(report, taskId) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new CodexWorkerError("Worker report must be an object");
  }
  const expectedKeys = [
    "branch",
    "commit",
    "files",
    "risks",
    "status",
    "summary",
    "taskId",
    "tests",
  ];
  if (
    JSON.stringify(Object.keys(report).sort()) !== JSON.stringify(expectedKeys)
  ) {
    throw new CodexWorkerError("Worker report fields do not match the schema");
  }
  if (report.taskId !== taskId) {
    throw new CodexWorkerError(
      `Worker report task ${report.taskId} does not match ${taskId}`,
    );
  }
  if (!new Set(["completed", "blocked", "failed"]).has(report.status)) {
    throw new CodexWorkerError(`Invalid worker status: ${report.status}`);
  }
  requireNonEmpty("summary", report.summary);
  for (const field of ["branch", "commit"]) {
    if (report[field] !== null && typeof report[field] !== "string") {
      throw new CodexWorkerError(`${field} must be a string or null`);
    }
  }
  for (const field of ["files", "risks"]) {
    if (
      !Array.isArray(report[field]) ||
      report[field].some((value) => typeof value !== "string")
    ) {
      throw new CodexWorkerError(`${field} must contain only strings`);
    }
  }
  if (!Array.isArray(report.tests)) {
    throw new CodexWorkerError("tests must be an array");
  }
  for (const test of report.tests) {
    if (
      !test ||
      typeof test !== "object" ||
      Array.isArray(test) ||
      JSON.stringify(Object.keys(test).sort()) !==
        JSON.stringify(["command", "result"]) ||
      !isNonEmpty(test.command) ||
      !isNonEmpty(test.result)
    ) {
      throw new CodexWorkerError("Each test requires command and result strings");
    }
  }
  return report;
}

async function runSpawnedProcess({
  file,
  args,
  cwd,
  env,
  stdoutPath,
  stderrPath,
}) {
  const [stdoutHandle, stderrHandle] = await Promise.all([
    open(stdoutPath, "wx", 0o600),
    open(stderrPath, "wx", 0o600),
  ]);
  let child;
  try {
    child = spawn(file, args, {
      cwd,
      env,
      stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
    });
  } finally {
    await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) =>
      resolve({ exitCode: exitCode ?? 1, signal }),
    );
  });
}

function artifactPaths(artifactDirectory) {
  const directory = path.resolve(artifactDirectory);
  return {
    directory,
    events: path.join(directory, "codex-events.jsonl"),
    stderr: path.join(directory, "codex-stderr.log"),
    report: path.join(directory, "report.json"),
  };
}

function parseJsonLines(contents, source) {
  return contents
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (cause) {
        throw new CodexWorkerError(
          `Invalid Codex JSONL in ${source} at line ${index + 1}`,
          { cause },
        );
      }
    });
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

function requireNonEmpty(label, value) {
  if (!isNonEmpty(value)) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function isNonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}
