import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const shellNames = new Set(["sh", "bash", "zsh", "fish"]);

export class HerdrPaneClient {
  constructor({ command = "herdr", env = process.env } = {}) {
    this.command = command;
    this.env = env;
  }

  async list() {
    const value = await this.#json(["pane", "list"]);
    const panes = value?.result?.panes;
    if (!Array.isArray(panes)) throw new HerdrPaneError("Malformed Herdr pane list");
    return panes.map(normalizePane);
  }

  async processInfo(paneId) {
    requirePaneId(paneId);
    const value = await this.#json(["pane", "process-info", "--pane", paneId]);
    const info = value?.result?.process_info;
    if (!info || !Array.isArray(info.foreground_processes)) {
      throw new HerdrPaneError(`Malformed process info for ${paneId}`);
    }
    return {
      paneId: requiredString(info.pane_id, "process pane ID"),
      shellPid: positiveInteger(info.shell_pid, "shell PID"),
      foregroundProcesses: info.foreground_processes.map((process) => ({
        pid: positiveInteger(process.pid, "process PID"),
        name: requiredString(process.name, "process name"),
        argv: Array.isArray(process.argv) ? process.argv.map(String) : [],
        cwd: requiredString(process.cwd, "process cwd"),
      })),
    };
  }

  async split({ paneId, cwd }) {
    requirePaneId(paneId);
    requiredString(cwd, "split cwd");
    const value = await this.#json([
      "pane", "split", paneId, "--direction", "right", "--cwd", cwd,
      "--no-focus",
    ]);
    const createdPaneId = findCreatedPaneId(value, paneId);
    if (!createdPaneId) throw new HerdrPaneError("Herdr split did not return a new pane ID");
    return { paneId: createdPaneId };
  }

  async run({ paneId, command }) {
    requirePaneId(paneId);
    requiredString(command, "pane command");
    try {
      await execFileAsync(this.command, ["pane", "run", paneId, command], {
        env: this.env,
        maxBuffer: 1024 * 1024,
      });
    } catch (cause) {
      throw new HerdrPaneError(`Herdr pane run failed for ${paneId}`, { cause });
    }
  }

  async reportAgent({
    paneId, source, agent, state, message, customStatus, seq,
    agentSessionId, agentSessionPath,
  }) {
    requirePaneId(paneId);
    if (!new Set(["idle", "working", "blocked", "unknown"]).has(state)) {
      throw new TypeError(`Unsupported Herdr agent state: ${state}`);
    }
    const args = [
      "pane", "report-agent", paneId, "--source", source, "--agent", agent,
      "--state", state,
    ];
    for (const [flag, value] of [
      ["--message", message],
      ["--custom-status", customStatus],
      ["--seq", seq],
      ["--agent-session-id", agentSessionId],
      ["--agent-session-path", agentSessionPath],
    ]) {
      if (value !== undefined && value !== null && value !== "") {
        args.push(flag, String(value));
      }
    }
    try {
      await this.#plain(args, `Herdr agent report failed for ${paneId}`);
    } catch (error) {
      if (!customStatus || !String(error.cause?.stderr || "").includes("--custom-status")) {
        throw error;
      }
      const flagIndex = args.indexOf("--custom-status");
      args.splice(flagIndex, 2);
      await this.#plain(args, `Herdr agent report failed for ${paneId}`);
    }
  }

  async releaseAgent({ paneId, source, agent, seq }) {
    requirePaneId(paneId);
    const args = [
      "pane", "release-agent", paneId, "--source", source, "--agent", agent,
    ];
    if (seq !== undefined) args.push("--seq", String(seq));
    await this.#plain(args, `Herdr agent release failed for ${paneId}`);
  }

  async #json(args) {
    let stdout;
    try {
      ({ stdout } = await execFileAsync(this.command, args, {
        env: this.env,
        maxBuffer: 10 * 1024 * 1024,
      }));
    } catch (cause) {
      throw new HerdrPaneError(`Herdr command failed: ${args.slice(0, 2).join(" ")}`, {
        cause,
      });
    }
    try {
      return JSON.parse(stdout);
    } catch (cause) {
      throw new HerdrPaneError("Herdr returned malformed JSON", { cause });
    }
  }

  async #plain(args, message) {
    try {
      await execFileAsync(this.command, args, {
        env: this.env,
        maxBuffer: 1024 * 1024,
      });
    } catch (cause) {
      throw new HerdrPaneError(message, { cause });
    }
  }
}

export class HerdrPanePool {
  constructor({ client, store, currentPaneId = process.env.HERDR_PANE_ID } = {}) {
    if (!client || !store || typeof store.listTaskIds !== "function") {
      throw new TypeError("HerdrPanePool requires a client and readable task store");
    }
    this.client = client;
    this.store = store;
    this.currentPaneId = currentPaneId || null;
  }

  async select({ count, cwd }) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 2) {
      throw new TypeError("Herdr worker pane count must be one or two");
    }
    requiredString(cwd, "worker cwd");
    const reserved = await this.#reservedPaneIds();
    let panes = await this.client.list();
    const current = panes.find(({ paneId }) => paneId === this.currentPaneId) || null;
    const ordered = panes
      .filter((pane) => pane.paneId !== this.currentPaneId)
      .sort((left, right) => {
        const leftLocal = current && left.tabId === current.tabId ? 0 : 1;
        const rightLocal = current && right.tabId === current.tabId ? 0 : 1;
        return leftLocal - rightLocal || left.paneId.localeCompare(right.paneId);
      });
    const selected = [];
    for (const pane of ordered) {
      if (selected.length === count) break;
      if (reserved.has(pane.paneId) || pane.agent !== null) continue;
      if (await this.#isVacant(pane)) selected.push(pane);
    }
    while (selected.length < count) {
      const anchor = this.currentPaneId || selected.at(-1)?.paneId;
      if (!anchor) {
        throw new HerdrPaneError("No current Herdr pane is available to create a worker pane");
      }
      const created = await this.client.split({ paneId: anchor, cwd });
      if (selected.some(({ paneId }) => paneId === created.paneId)) {
        throw new HerdrPaneError(`Herdr returned duplicate worker pane ${created.paneId}`);
      }
      const pane = normalizePane({
        pane_id: created.paneId,
        tab_id: current?.tabId || "unknown",
        workspace_id: current?.workspaceId || "unknown",
        cwd,
        agent_status: "unknown",
      });
      if (!(await this.#isVacant(pane))) {
        throw new HerdrPaneError(`New Herdr pane ${pane.paneId} is not vacant`);
      }
      selected.push(pane);
    }
    return selected;
  }

  async #isVacant(pane) {
    const info = await this.client.processInfo(pane.paneId);
    if (info.paneId !== pane.paneId || info.foregroundProcesses.length !== 1) {
      return false;
    }
    const process = info.foregroundProcesses[0];
    return process.pid === info.shellPid && shellNames.has(process.name.replace(/^-/, ""));
  }

  async #reservedPaneIds() {
    const result = new Set();
    for (const taskId of await this.store.listTaskIds()) {
      const snapshot = await this.store.getSnapshot(taskId);
      for (const worker of snapshot.workers) {
        if (
          worker.paneId &&
          new Set(["dispatch_requested", "started"]).has(worker.status)
        ) result.add(worker.paneId);
      }
    }
    return result;
  }
}

export class HerdrPaneWorkerLauncher {
  constructor({
    client,
    nodePath = process.execPath,
    workerScript,
    stateDirectory,
    timeoutMs = 3_600_000,
    pollMs = 250,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    if (!client || !workerScript || !stateDirectory) {
      throw new TypeError(
        "HerdrPaneWorkerLauncher requires client, workerScript, and stateDirectory",
      );
    }
    this.client = client;
    this.nodePath = nodePath;
    this.workerScript = workerScript;
    this.stateDirectory = stateDirectory;
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
    this.delay = delay;
  }

  async run({ taskId, workerId, paneId, worktreePath }) {
    const identity = workerIdentity(taskId, workerId);
    await this.client.reportAgent({
      paneId,
      ...identity,
      state: "working",
      message: `Read-only scout ${workerId}`,
      customStatus: "read-only",
      seq: 1,
      agentSessionId: workerId,
      agentSessionPath: worktreePath,
    });
    try {
      await this.client.run({
        paneId,
        command: [
          this.nodePath,
          this.workerScript,
          this.stateDirectory,
          taskId,
          workerId,
        ].map(shellQuote).join(" "),
      });
      const marker = await this.#waitForTerminalMarker({ taskId, workerId, paneId });
      if (marker.status !== "completed") {
        throw new HerdrPaneWorkerProcessError(
          `Pane worker ${workerId} failed (${marker.errorName})`,
        );
      }
      await this.client.reportAgent({
        paneId,
        ...identity,
        state: "idle",
        message: `Scout ${workerId} awaiting Firstmate verification`,
        customStatus: "verifying",
        seq: 2,
        agentSessionId: workerId,
        agentSessionPath: worktreePath,
      });
    } catch (cause) {
      await this.client.reportAgent({
        paneId,
        ...identity,
        state: "blocked",
        message: `Scout ${workerId} needs reconciliation`,
        customStatus: "recovery",
        seq: 2,
        agentSessionId: workerId,
        agentSessionPath: worktreePath,
      }).catch(() => {});
      throw cause;
    }
  }

  async release({ taskId, workerId, paneId }) {
    await this.client.releaseAgent({
      paneId,
      ...workerIdentity(taskId, workerId),
      seq: 3,
    });
  }

  async #waitForTerminalMarker({ taskId, workerId, paneId }) {
    const target = path.join(
      this.stateDirectory,
      "tasks",
      taskId,
      "workers",
      workerId,
      "pane-terminal.json",
    );
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() <= deadline) {
      try {
        const marker = JSON.parse(await readFile(target, "utf8"));
        validateTerminalMarker(marker, { taskId, workerId, paneId });
        return marker;
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      await this.delay(this.pollMs);
    }
    throw new HerdrPaneError(`Timed out waiting for pane worker ${workerId}`);
  }
}

export class HerdrPaneError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "HerdrPaneError";
  }
}

export class HerdrPaneWorkerProcessError extends HerdrPaneError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "HerdrPaneWorkerProcessError";
    this.definitive = true;
  }
}

export function shellQuote(value) {
  const text = String(value);
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

function workerIdentity(taskId, workerId) {
  return {
    source: `shipmates:worker:${taskId}:${workerId}`,
    agent: `ShipMates ${workerId}`,
  };
}

function validateTerminalMarker(marker, expected) {
  const keys = [
    "completedAt", "errorName", "paneId", "schemaVersion", "status", "taskId",
    "workerId",
  ];
  if (
    !marker || typeof marker !== "object" || Array.isArray(marker) ||
    Object.keys(marker).sort().join(",") !== keys.sort().join(",") ||
    marker.schemaVersion !== 1 || marker.taskId !== expected.taskId ||
    marker.workerId !== expected.workerId || marker.paneId !== expected.paneId ||
    !new Set(["completed", "failed"]).has(marker.status) ||
    Number.isNaN(Date.parse(marker.completedAt)) ||
    (marker.status === "completed" && marker.errorName !== null) ||
    (marker.status === "failed" &&
      (typeof marker.errorName !== "string" || marker.errorName === ""))
  ) {
    throw new HerdrPaneError("Pane terminal marker identity is invalid");
  }
}

function normalizePane(value) {
  return {
    paneId: requiredString(value.pane_id, "pane ID"),
    tabId: requiredString(value.tab_id, "tab ID"),
    workspaceId: requiredString(value.workspace_id, "workspace ID"),
    cwd: requiredString(value.cwd, "pane cwd"),
    agentStatus: value.agent_status || "unknown",
    agent: typeof value.agent === "string" && value.agent ? value.agent : null,
  };
}

function findCreatedPaneId(value, existingPaneId) {
  const candidates = [];
  visit(value, (key, item) => {
    if (key === "pane_id" && typeof item === "string" && item !== existingPaneId) {
      candidates.push(item);
    }
  });
  return [...new Set(candidates)].at(-1) || null;
}

function visit(value, callback) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    callback(key, item);
    if (item && typeof item === "object") visit(item, callback);
  }
}

function requirePaneId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9:_-]+$/u.test(value)) {
    throw new TypeError("paneId must be a safe Herdr pane ID");
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HerdrPaneError(`${label} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HerdrPaneError(`${label} must be a positive integer`);
  }
  return value;
}
