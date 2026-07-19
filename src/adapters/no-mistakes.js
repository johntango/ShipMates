import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LOCAL_ONLY_SKIP_STEPS = Object.freeze([
  "rebase",
  "push",
  "pr",
  "ci",
]);

export const FAST_LOCAL_SKIP_STEPS = Object.freeze([
  "rebase",
  "review",
  "document",
  "push",
  "pr",
  "ci",
]);

export const PINNED_NO_MISTAKES_DARWIN_ARM64 = Object.freeze({
  version: "v1.37.0",
  sourceCommit: "78e4dcb234274199717acafa90abca5cf7013993",
  binarySha256: "d4558d241100cb48196a00864157fb70bb5aa241ac376bcbf48dda88fb033e34",
});

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
    binaryReader = readFile,
    pin = PINNED_NO_MISTAKES_DARWIN_ARM64,
    clock = () => new Date(),
    timeoutMs = 30 * 60 * 1_000,
    skipSteps = LOCAL_ONLY_SKIP_STEPS,
    onProgress = () => {},
  } = {}) {
    requireNonEmpty(binaryPath, "binaryPath");
    if (typeof runner !== "function") throw new TypeError("runner must be a function");
    if (typeof binaryReader !== "function") {
      throw new TypeError("binaryReader must be a function");
    }
    if (typeof onProgress !== "function") {
      throw new TypeError("onProgress must be a function");
    }
    validatePin(pin);
    this.binaryPath = path.resolve(binaryPath);
    this.stateRoot = path.resolve(stateRoot);
    this.runner = runner;
    this.binaryReader = binaryReader;
    this.pin = Object.freeze({ ...pin });
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.skipSteps = validateSkipSteps(skipSteps);
    this.onProgress = onProgress;
  }

  async run({ taskId, worktreePath, expectedHeadSha, intent }) {
    requireNonEmpty(taskId, "taskId");
    requireNonEmpty(intent, "intent");
    const expected = fullSha(expectedHeadSha, "expectedHeadSha");
    const workingDirectory = path.resolve(worktreePath);
    const pinEvidence = await this.verifyPin();
    const runtimeHome = await this.#runtimeHome(workingDirectory);
    await this.#initialize({ runtimeHome, worktreePath: workingDirectory });
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
      this.skipSteps.join(","),
    ];
    this.onProgress("Starting validation pipeline");
    const startedAt = this.clock().toISOString();
    const result = await this.runner(this.binaryPath, args, {
      cwd: workingDirectory,
      env: localOnlyEnvironment({
        taskRoot: runtimeHome,
      }),
      timeout: this.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      onStderrLine: this.onProgress,
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
        pinned: true,
        version: pinEvidence.version,
        sourceCommit: pinEvidence.sourceCommit,
        binarySha256: pinEvidence.binarySha256,
      },
      mode: "local-only",
      remoteOperations: false,
      intentSha256: digest(intent),
      command: {
        args,
        skipSteps: [...this.skipSteps],
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

  pinEvidence() {
    return Object.freeze({
      name: "no-mistakes",
      pinned: true,
      version: this.pin.version,
      sourceCommit: this.pin.sourceCommit,
      binarySha256: this.pin.binarySha256,
    });
  }

  async #initialize({ runtimeHome, worktreePath }) {
    const result = await this.runner(this.binaryPath, ["init"], {
      cwd: worktreePath,
      env: localOnlyEnvironment({ taskRoot: runtimeHome }),
      timeout: this.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.exitCode !== 0) {
      throw new NoMistakesGateError(
        "Could not initialize the pinned local validation repository",
      );
    }
  }

  async #runtimeHome(worktreePath) {
    const existing = await this.runner(
      "git",
      ["remote", "get-url", "no-mistakes"],
      {
        cwd: worktreePath,
        env: process.env,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      },
    );
    let taskRoot = path.join(this.stateRoot, "runtime");
    if (existing.exitCode === 0) {
      const remotePath = path.resolve(existing.stdout.trim());
      const reposPath = path.dirname(remotePath);
      const existingRoot = path.dirname(reposPath);
      const relative = path.relative(this.stateRoot, existingRoot);
      if (path.basename(reposPath) !== "repos" || relative.startsWith("..") ||
        path.isAbsolute(relative)) {
        throw new NoMistakesGateError(
          "Existing no-mistakes remote is outside the managed validation state",
        );
      }
      taskRoot = existingRoot;
    } else if (!(existing.exitCode === 2 ||
      (existing.exitCode === 128 && /no such remote/iu.test(existing.stderr)))) {
      throw new NoMistakesGateError("Could not inspect the no-mistakes Git remote");
    } else {
      const origin = await this.runner("git", ["remote", "get-url", "origin"], {
        cwd: worktreePath,
        env: process.env,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      if (origin.exitCode === 0 && origin.stdout.trim()) {
        taskRoot = path.join(this.stateRoot, "runtime", digest(origin.stdout.trim()).slice(0, 16));
      }
    }
    await mkdir(taskRoot, { recursive: true });
    if (Buffer.byteLength(path.join(taskRoot, "socket"), "utf8") <= 100) {
      return taskRoot;
    }
    const linksRoot = path.join(tmpdir(), "shipmates-no-mistakes-runtime");
    const linkPath = path.join(linksRoot, digest(taskRoot).slice(0, 16));
    await mkdir(linksRoot, { recursive: true });
    try {
      const metadata = await lstat(linkPath);
      if (!metadata.isSymbolicLink() || path.resolve(await readlink(linkPath)) !== taskRoot) {
        throw new NoMistakesGateError(
          "Short no-mistakes runtime path is already bound to another target",
        );
      }
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw cause;
      await symlink(taskRoot, linkPath, "dir");
    }
    return linkPath;
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

  async verifyPin() {
    let bytes;
    try {
      bytes = await this.binaryReader(this.binaryPath);
    } catch (cause) {
      throw new NoMistakesGateError("Could not read pinned no-mistakes binary", {
        cause,
      });
    }
    const binarySha256 = digest(bytes);
    if (binarySha256 !== this.pin.binarySha256) {
      throw new NoMistakesGateError("no-mistakes binary digest does not match its pin");
    }
    const result = await this.runner(this.binaryPath, ["--version"], {
      cwd: path.dirname(this.binaryPath),
      env: localOnlyEnvironment({ stateRoot: this.stateRoot, taskId: "pin-check" }),
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const match = /^no-mistakes version (v\d+\.\d+\.\d+) \(([a-f0-9]{7,40})\)(?:\s|$)/u
      .exec(result.stdout.trim());
    if (result.exitCode !== 0 || !match || match[1] !== this.pin.version ||
      !this.pin.sourceCommit.startsWith(match[2])) {
      throw new NoMistakesGateError("no-mistakes version does not match its pin");
    }
    return this.pin;
  }
}

function validateSkipSteps(steps) {
  if (!Array.isArray(steps) || steps.some((step) => !allSteps.includes(step))) {
    throw new TypeError("skipSteps must contain known no-mistakes steps");
  }
  return Object.freeze([...new Set(steps)]);
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
  if (typeof options.onStderrLine === "function") {
    return runStreamingCommand(command, args, options);
  }
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

function runStreamingCommand(command, args, options) {
  const { onStderrLine, maxBuffer, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, spawnOptions);
    let stdout = "";
    let stderr = "";
    let stderrRemainder = "";
    let settled = false;
    const timer = options.timeout > 0
      ? setTimeout(() => child.kill("SIGTERM"), options.timeout)
      : null;

    const append = (current, chunk) => {
      const next = current + chunk;
      if (maxBuffer && Buffer.byteLength(next) > maxBuffer) {
        child.kill("SIGTERM");
        reject(new NoMistakesGateError(`Output exceeded maxBuffer for ${path.basename(command)}`));
        settled = true;
      }
      return next;
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
      stderrRemainder += chunk;
      const lines = stderrRemainder.split(/\r?\n/u);
      stderrRemainder = lines.pop() || "";
      for (const line of lines) if (line.trim()) onStderrLine(line.trim());
    });
    child.once("error", (cause) => {
      if (timer) clearTimeout(timer);
      if (!settled) reject(new NoMistakesGateError(`Could not run ${path.basename(command)}`, { cause }));
    });
    child.once("close", (exitCode) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      if (stderrRemainder.trim()) onStderrLine(stderrRemainder.trim());
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

function localOnlyEnvironment({ stateRoot, taskId, taskRoot }) {
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
  const resolvedTaskRoot = taskRoot || path.join(stateRoot, taskId);
  return {
    ...env,
    NM_HOME: resolvedTaskRoot,
    GH_CONFIG_DIR: path.join(resolvedTaskRoot, "empty-gh"),
    GLAB_CONFIG_DIR: path.join(resolvedTaskRoot, "empty-glab"),
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

function validatePin(pin) {
  if (!pin || typeof pin !== "object" ||
    !/^v\d+\.\d+\.\d+$/u.test(pin.version) ||
    !/^[a-f0-9]{40}$/u.test(pin.sourceCommit) ||
    !/^[a-f0-9]{64}$/u.test(pin.binarySha256)) {
    throw new TypeError("pin must contain exact version, source commit, and binary digest");
  }
}
