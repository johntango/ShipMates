const workerOrder = Object.freeze(["scout-1", "scout-2"]);

export class HerdrFirstmateSession {
  constructor({
    client,
    paneId,
    sessionId = `firstmate-${process.pid}`,
    onWarning = console.error,
  } = {}) {
    if (!client) throw new TypeError("HerdrFirstmateSession requires a client");
    this.client = client;
    this.paneId = paneId || null;
    this.sessionId = sessionId;
    this.onWarning = onWarning;
    this.repoPath = null;
    this.started = false;
  }

  async start({ repoPath }) {
    if (!this.paneId) return;
    this.repoPath = repoPath;
    try {
      await this.#releaseStaleNativeCodexSession();
      await this.client.reportAgent({
        paneId: this.paneId,
        source: this.#source(),
        agent: "ShipMates FirstMate",
        state: "working",
        message: "FirstMate is listening",
        customStatus: "listening",
        seq: 1,
        agentSessionId: this.sessionId,
        agentSessionPath: repoPath,
      });
      this.started = true;
      await this.client.reportMetadata({
        paneId: this.paneId,
        source: this.#source(),
        appliesToSource: "herdr:codex",
        displayAgent: "ShipMates FirstMate",
        customStatus: "listening",
        stateLabels: { idle: "running" },
        seq: 1,
      });
      await this.client.rename({
        paneId: this.paneId,
        label: "ShipMates FirstMate",
      });
    } catch (error) {
      this.onWarning(`Herdr FirstMate session visibility unavailable: ${safeErrorName(error)}`);
    }
  }

  async stop() {
    if (!this.paneId || !this.started) return;
    try {
      await this.client.rename({ paneId: this.paneId, label: null });
      await this.client.reportMetadata({
        paneId: this.paneId,
        source: this.#source(),
        appliesToSource: "herdr:codex",
        clearDisplayAgent: true,
        clearCustomStatus: true,
        clearStateLabels: true,
        seq: 2,
      });
      await this.client.releaseAgent({
        paneId: this.paneId,
        source: this.#source(),
        agent: "ShipMates FirstMate",
        seq: 2,
      });
      this.started = false;
    } catch (error) {
      this.onWarning(`Herdr FirstMate session release unavailable: ${safeErrorName(error)}`);
    }
  }

  async #releaseStaleNativeCodexSession() {
    if (typeof this.client.processInfo !== "function") return;
    const info = await this.client.processInfo(this.paneId);
    const firstmateOwnsPane = info.foregroundProcesses.some(({ argv }) =>
      argv.join(" ").includes("scripts/firstmate.js"));
    if (!firstmateOwnsPane) {
      throw new Error("HERDR_PANE_ID does not contain the FirstMate process");
    }
    await this.client.releaseAgent({
      paneId: this.paneId,
      source: "herdr:codex",
      agent: "codex",
    });
  }

  #source() {
    return `shipmates:firstmate:interactive:${this.paneId}`;
  }
}

export class HerdrExecutionObserver {
  constructor({ client, panePool, currentPaneId, onWarning = console.error } = {}) {
    if (!client || !panePool) {
      throw new TypeError("HerdrExecutionObserver requires client and panePool");
    }
    this.client = client;
    this.panePool = panePool;
    this.currentPaneId = currentPaneId || null;
    this.onWarning = onWarning;
    this.taskId = null;
    this.repoPath = null;
    this.panes = new Map();
    this.sequences = new Map();
    this.disabled = !this.currentPaneId;
    this.warningEmitted = false;
  }

  async firstmateStage({ taskId, repoPath, message, customStatus, state = "working" }) {
    if (!this.currentPaneId) return;
    await this.#bestEffort(async () => {
      this.taskId = taskId;
      this.repoPath = repoPath;
      await this.client.reportAgent({
        paneId: this.currentPaneId,
        source: `shipmates:firstmate:${taskId}`,
        agent: "ShipMates Firstmate",
        state,
        message: sanitizeStatus(message),
        customStatus: sanitizeStatus(customStatus),
        seq: this.#next("firstmate"),
        agentSessionId: taskId,
        agentSessionPath: repoPath,
      });
    });
  }

  async begin({ taskId, repoPath, workerCount = 2 }) {
    if (this.disabled) return;
    await this.#bestEffort(async () => {
      this.taskId = taskId;
      this.repoPath = repoPath;
      const panes = await this.panePool.select({ count: workerCount, cwd: repoPath });
      workerOrder.slice(0, workerCount)
        .forEach((workerId, index) => this.panes.set(workerId, panes[index].paneId));
    });
  }

  async workerStarted({ workerId, sandbox }) {
    await this.#workerReport(workerId, {
      state: "working",
      message: `${workerId} started`,
      customStatus: sandbox,
    });
  }

  async workerEvent({ workerId, event }) {
    const activity = describeCodexActivity(event);
    if (!activity) return;
    await this.#workerReport(workerId, {
      state: "working",
      message: activity.message,
      customStatus: activity.status,
    });
  }

  async workerFinished({ workerId, report }) {
    await this.#workerReport(workerId, {
      state: "idle",
      message: `${workerId} ${report?.status || "completed"}`,
      customStatus: "completed",
    });
  }

  async workerFailed({ workerId, error }) {
    await this.#workerReport(workerId, {
      state: "blocked",
      message: `${workerId} failed (${safeErrorName(error)})`,
      customStatus: "failed",
    });
  }

  async prepareImplementer() {
    if (this.disabled) return;
    const paneId = this.panes.get("scout-1");
    if (!paneId) return;
    await this.#bestEffort(async () => {
      await this.#release("scout-1");
      this.panes.set("implementer", paneId);
    });
  }

  paneIdFor(workerId) {
    return this.disabled ? null : this.panes.get(workerId) || null;
  }

  async end({ status = "completed" } = {}) {
    await this.#finalizeFirstmate(status);
    for (const workerId of [...this.panes.keys()]) await this.#release(workerId);
  }

  async #finalizeFirstmate(status) {
    if (!this.currentPaneId || !this.taskId) return;
    try {
      await this.client.reportAgent({
        paneId: this.currentPaneId,
        source: `shipmates:firstmate:${this.taskId}`,
        agent: "ShipMates Firstmate",
        state: new Set(["failed", "awaiting-human"]).has(status) ? "blocked" : "working",
        message: sanitizeStatus(new Set(["failed", "awaiting-human"]).has(status)
          ? `Execution ${status}`
          : "FirstMate is listening"),
        customStatus: sanitizeStatus(new Set(["failed", "awaiting-human"]).has(status)
          ? status
          : "listening"),
        seq: this.#next("firstmate"),
        agentSessionId: this.taskId,
        agentSessionPath: this.repoPath,
      });
    } catch (error) {
      this.#warn(error);
    }
  }

  async #workerReport(workerId, { state, message, customStatus }) {
    if (this.disabled) return;
    const paneId = this.panes.get(workerId);
    if (!paneId) return;
    await this.#bestEffort(() => this.client.reportAgent({
      paneId,
      source: `shipmates:worker:${this.taskId}:${workerId}`,
      agent: `ShipMates ${workerId}`,
      state,
      message: sanitizeStatus(message),
      customStatus: sanitizeStatus(customStatus),
      seq: this.#next(workerId),
      agentSessionId: workerId,
      agentSessionPath: this.repoPath,
    }));
  }

  async #release(workerId) {
    const paneId = this.panes.get(workerId);
    if (!paneId) return;
    try {
      await this.client.releaseAgent({
        paneId,
        source: `shipmates:worker:${this.taskId}:${workerId}`,
        agent: `ShipMates ${workerId}`,
        seq: this.#next(workerId),
      });
    } catch (error) {
      this.#warn(error);
    } finally {
      this.panes.delete(workerId);
    }
  }

  #next(identity) {
    const value = (this.sequences.get(identity) || 0) + 1;
    this.sequences.set(identity, value);
    return value;
  }

  async #bestEffort(operation) {
    if (this.disabled) return;
    try {
      await operation();
    } catch (error) {
      this.disabled = true;
      this.#warn(error);
    }
  }

  #warn(error) {
    if (this.warningEmitted) return;
    this.warningEmitted = true;
    this.onWarning?.(`Herdr visibility disabled: ${safeErrorName(error)}`);
  }
}

export function describeCodexActivity(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "thread.started") {
    return { status: "reasoning", message: "Codex thread started" };
  }
  if (!new Set(["item.started", "item.completed"]).has(event.type)) return null;
  const item = event.item;
  if (!item || typeof item !== "object") return null;
  const phase = event.type === "item.started" ? "started" : resultPhase(item);
  switch (item.type) {
    case "command_execution":
      return { status: "tool:shell", message: `tool shell ${phase}` };
    case "file_change":
      return { status: "tool:file-edit", message: `tool file-edit ${phase}` };
    case "mcp_tool_call":
      return {
        status: "tool:mcp",
        message: `tool ${safeToolName(item.tool || item.name || "mcp")} ${phase}`,
      };
    case "web_search":
      return { status: "tool:web-search", message: `tool web-search ${phase}` };
    case "skill_invocation":
    case "skill":
      return {
        status: "skill",
        message: `skill ${safeToolName(item.skill || item.name || "unknown")} ${phase}`,
      };
    default:
      return null;
  }
}

function resultPhase(item) {
  if (item.status === "failed" || (Number.isInteger(item.exit_code) && item.exit_code !== 0)) {
    return "failed";
  }
  return "completed";
}

function sanitizeStatus(value) {
  return String(value || "").replace(/[\p{Cc}\p{Cf}]/gu, "?").slice(0, 120);
}

function safeToolName(value) {
  return String(value).replace(/[^A-Za-z0-9_.:-]/gu, "?").slice(0, 64);
}

function safeErrorName(error) {
  return error?.name || "Error";
}
