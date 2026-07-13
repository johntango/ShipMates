import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LOCAL_ONLY_SKIP_STEPS = Object.freeze([
  "rebase",
  "push",
  "pr",
  "ci",
]);

const allSteps = Object.freeze([
  "intent",
  "rebase",
  "review",
  "test",
  "document",
  "lint",
  "push",
  "pr",
  "ci",
]);

export class NoMistakesLocalGate {
  constructor({
    binaryPath,
    stateRoot = path.resolve(".shipmates/no-mistakes"),
    runner = runCommand,
    clock = () => new Date(),
    timeoutMs = 30 * 60 * 1_000,
  } = {}) {
    requireNonEmpty(binaryPath, "binaryPath");
    if (typeof runner !== "function") throw new TypeError("runner must be a function");
    this.binaryPath = path.resolve(binaryPath);
    this.stateRoot = path.resolve(stateRoot);
    this.runner = runner;
    this.clock = clock;
    this.timeoutMs = timeoutMs;
  }

  async run({ taskId, worktreePath, expectedHeadSha, intent }) {
    requireNonEmpty(taskId, "taskId");
    requireNonEmpty(intent, "intent");
    const expected = fullSha(expectedHeadSha, "expectedHeadSha");
    const workingDirectory = path.resolve(worktreePath);
    const before = await this.#inspect(workingDirectory);
    if (before.headSha !== expected || before.dirty) {
      throw new NoMistakesGateError(
        "Local validation requires a clean worktree at the exact expected head",
      );
    }

    const args = [
      "axi",
      "run",
      "--intent",
      intent,
      "--skip",
      LOCAL_ONLY_SKIP_STEPS.join(","),
    ];
    const startedAt = this.clock().toISOString();
    const result = await this.runner(this.binaryPath, args, {
      cwd: workingDirectory,
      env: localOnlyEnvironment({
        stateRoot: this.stateRoot,
        taskId,
      }),
      timeout: this.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    const completedAt = this.clock().toISOString();
    const parsed = parseAxiOutput(result.stdout);
    const after = await this.#inspect(workingDirectory);
    if (after.branch !== before.branch || after.dirty) {
      throw new NoMistakesGateError(
        "Validator changed branches or left the worktree dirty",
      );
    }
    if (!after.headSha.startsWith(parsed.head)) {
      throw new NoMistakesGateError(
        "Validator output head does not match independent Git inspection",
      );
    }

    validateLocalSteps(parsed.steps, { terminal: parsed.outcome !== null });
    const passed =
      result.exitCode === 0 &&
      parsed.outcome === "passed" &&
      parsed.gate === null &&
      before.headSha === after.headSha &&
      parsed.steps.every(({ status }) =>
        new Set(["completed", "skipped"]).has(status),
      );
    return {
      schemaVersion: 1,
      taskId,
      tool: {
        name: "no-mistakes",
        binary: this.binaryPath,
      },
      mode: "local-only",
      remoteOperations: false,
      command: {
        args,
        skipSteps: [...LOCAL_ONLY_SKIP_STEPS],
      },
      startedAt,
      completedAt,
      branch: after.branch,
      initialHeadSha: before.headSha,
      finalHeadSha: after.headSha,
      headChanged: before.headSha !== after.headSha,
      runId: parsed.runId,
      runStatus: parsed.runStatus,
      outcome: parsed.outcome,
      passed,
      findings: parsed.findings,
      steps: parsed.steps,
      gate: parsed.gate,
      process: {
        exitCode: result.exitCode,
        stdoutSha256: digest(result.stdout),
        stderrSha256: digest(result.stderr),
      },
    };
  }

  async #inspect(worktreePath) {
    const options = {
      cwd: worktreePath,
      env: process.env,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    };
    const head = await this.runner("git", ["rev-parse", "HEAD"], options);
    const branch = await this.runner(
      "git",
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      options,
    );
    const status = await this.runner(
      "git",
      ["status", "--porcelain=v1", "-z"],
      options,
    );
    if (head.exitCode !== 0 || branch.exitCode !== 0 || status.exitCode !== 0) {
      throw new NoMistakesGateError("Could not independently inspect validation worktree");
    }
    return {
      headSha: fullSha(head.stdout.trim(), "Git HEAD"),
      branch: requireNonEmpty(branch.stdout.trim(), "Git branch"),
      dirty: status.stdout.length > 0,
    };
  }
}

export function parseAxiOutput(stdout) {
  requireNonEmpty(stdout, "axi stdout");
  const lines = stdout.replaceAll("\r\n", "\n").split("\n");
  const topLevel = new Map();
  for (const line of lines) {
    const match = /^([a-z_]+):(?:\s*(.*))?$/u.exec(line);
    if (match) topLevel.set(match[1], unquote(match[2] || ""));
  }
  const runStart = lines.indexOf("run:");
  if (runStart < 0) throw new NoMistakesOutputError("axi output lacks run object");
  const runFields = new Map();
  let steps = null;
  for (let index = runStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[a-z_]+:/u.test(line)) break;
    const field = /^  ([a-z_]+):\s*(.*)$/u.exec(line);
    if (field) {
      runFields.set(field[1], unquote(field[2]));
      continue;
    }
    const table = /^  steps\[(\d+)\]\{step,status,findings,duration_ms\}:$/u.exec(line);
    if (table) {
      const count = Number(table[1]);
      steps = lines
        .slice(index + 1, index + 1 + count)
        .map((row) => parseStepRow(row));
      index += count;
    }
  }
  if (!steps || steps.length !== allSteps.length) {
    throw new NoMistakesOutputError("axi output must contain every pipeline step");
  }
  const outcome = topLevel.get("outcome") || null;
  const gate = lines.includes("gate:") ? parseGate(lines) : null;
  if (!outcome && !gate) {
    throw new NoMistakesOutputError("axi output has neither outcome nor approval gate");
  }
  if (outcome && !new Set(["passed", "blocked", "failed", "cancelled"]).has(outcome)) {
    throw new NoMistakesOutputError(`Unexpected local validation outcome: ${outcome}`);
  }
  return {
    runId: requiredField(runFields, "id"),
    branch: requiredField(runFields, "branch"),
    runStatus: requiredField(runFields, "status"),
    head: shortSha(requiredField(runFields, "head")),
    findings: parseFindingsCount(requiredField(runFields, "findings")),
    steps,
    outcome,
    gate,
  };
}

export class NoMistakesGateError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "NoMistakesGateError";
  }
}

export class NoMistakesOutputError extends NoMistakesGateError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "NoMistakesOutputError";
  }
}

async function runCommand(command, args, options) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, options);
    return { exitCode: 0, stdout, stderr };
  } catch (cause) {
    if (typeof cause.code !== "number") {
      throw new NoMistakesGateError(`Could not run ${path.basename(command)}`, {
        cause,
      });
    }
    return {
      exitCode: cause.code,
      stdout: cause.stdout || "",
      stderr: cause.stderr || "",
    };
  }
}

function localOnlyEnvironment({ stateRoot, taskId }) {
  const env = { ...process.env };
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITLAB_TOKEN",
    "GLAB_TOKEN",
    "NO_MISTAKES_BITBUCKET_API_TOKEN",
    "AZURE_DEVOPS_EXT_PAT",
    "OPENAI_API_KEY",
  ]) {
    delete env[name];
  }
  const taskRoot = path.join(stateRoot, taskId);
  return {
    ...env,
    NM_HOME: taskRoot,
    GH_CONFIG_DIR: path.join(taskRoot, "empty-gh"),
    GLAB_CONFIG_DIR: path.join(taskRoot, "empty-glab"),
    NO_MISTAKES_TELEMETRY: "0",
    NO_MISTAKES_NO_UPDATE_CHECK: "1",
  };
}

function validateLocalSteps(steps, { terminal }) {
  if (steps.map(({ step }) => step).join(",") !== allSteps.join(",")) {
    throw new NoMistakesOutputError("axi output pipeline order is malformed");
  }
  for (const step of steps) {
    const allowedRemoteStatuses = terminal
      ? new Set(["skipped"])
      : new Set(["pending", "skipped"]);
    if (
      LOCAL_ONLY_SKIP_STEPS.includes(step.step) &&
      !allowedRemoteStatuses.has(step.status)
    ) {
      throw new NoMistakesOutputError(
        `Remote-capable step ${step.step} was not skipped`,
      );
    }
  }
}

function parseStepRow(line) {
  const match = /^    ([a-z]+),([a-z_]+),(\d+),(\d+)$/u.exec(line);
  if (!match) throw new NoMistakesOutputError(`Malformed axi step row: ${line}`);
  return {
    step: match[1],
    status: match[2],
    findings: Number(match[3]),
    durationMs: Number(match[4]),
  };
}

function parseGate(lines) {
  const start = lines.indexOf("gate:");
  const fields = new Map();
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^  ([a-z_]+):\s*(.*)$/u.exec(lines[index]);
    if (match) fields.set(match[1], unquote(match[2]));
    else if (/^[a-z_]+:/u.test(lines[index])) break;
  }
  return {
    step: requiredField(fields, "step"),
    status: requiredField(fields, "status"),
  };
}

function parseFindingsCount(value) {
  if (value === "none") return 0;
  const match = /^(\d+)/u.exec(value);
  if (!match) throw new NoMistakesOutputError("Malformed findings tally");
  return Number(match[1]);
}

function requiredField(fields, name) {
  return requireNonEmpty(fields.get(name), `axi run.${name}`);
}

function unquote(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch (cause) {
      throw new NoMistakesOutputError("Malformed quoted axi field", { cause });
    }
  }
  return value;
}

function fullSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/iu.test(value)) {
    throw new NoMistakesGateError(`${label} must be a full SHA`);
  }
  return value.toLowerCase();
}

function shortSha(value) {
  if (!/^[a-f0-9]{7,40}$/iu.test(value)) {
    throw new NoMistakesOutputError("axi run.head must be a hexadecimal SHA");
  }
  return value.toLowerCase();
}

function requireNonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new NoMistakesGateError(`${label} must be a non-empty string`);
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
