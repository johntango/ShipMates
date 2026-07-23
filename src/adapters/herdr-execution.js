const workerOrder = Object.freeze(["scout-1", "scout-2"]);

export class HerdrFirstmateSession {
  constructor({
    client,
    paneId,
    sessionId = `firstmate-${process.pid}`,
    onWarning = console.error,
    activityMinimumMs = 1_000,
    activityHeartbeatMs = 5_000,
    clock = Date.now,
    schedule = setTimeout,
    cancelScheduled = clearTimeout,
  } = {}) {
    if (!client) throw new TypeError("HerdrFirstmateSession requires a client");
    this.client = client;
    this.paneId = paneId || null;
    this.sessionId = sessionId;
    this.onWarning = onWarning;
    if (!Number.isSafeInteger(activityMinimumMs) || activityMinimumMs < 0 ||
      !Number.isSafeInteger(activityHeartbeatMs) || activityHeartbeatMs < 1) {
      throw new TypeError("Herdr FirstMate activity intervals are invalid");
    }
    this.activityMinimumMs = activityMinimumMs;
    this.activityHeartbeatMs = activityHeartbeatMs;
    this.clock = clock;
    this.schedule = schedule;
    this.cancelScheduled = cancelScheduled;
    this.idleTimer = null;
    this.repoPath = null;
    this.started = false;
    this.sequence = 0;
    this.activeOperations = 0;
  }

  async start({ repoPath }) {
    if (!this.paneId) return;
    this.repoPath = repoPath;
    try {
      await this.#verifyPaneOwnership();
      if (typeof this.client.renameAgent === "function") {
        await this.client.renameAgent({
          paneId: this.paneId,
          label: "ShipMates FirstMate",
        });
      }
      await this.#report({ state: "idle", message: "FirstMate is listening", status: "listening" });
      this.started = true;
    } catch (error) {
      this.onWarning(`Herdr FirstMate registration unavailable: ${safeErrorName(error)}`);
      return;
    }
    try {
      await this.client.rename({
        paneId: this.paneId,
        label: "ShipMates FirstMate",
      });
    } catch (error) {
      this.onWarning(`Herdr FirstMate pane decoration unavailable: ${safeErrorName(error)}`);
    }
  }

  async withActivity({ message, status = "active" }, operation) {
    if (typeof operation !== "function") throw new TypeError("FirstMate activity requires an operation");
    const startedAt = this.clock();
    if (this.idleTimer !== null) {
      this.cancelScheduled(this.idleTimer);
      this.idleTimer = null;
    }
    this.activeOperations += 1;
    const heartbeat = this.started ? setInterval(() => void this.#reportActivity({
      state: "working", message, status,
    }), this.activityHeartbeatMs) : null;
    heartbeat?.unref?.();
    try {
      await this.#reportActivity({ state: "working", message, status });
      return await operation();
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.activeOperations -= 1;
      if (this.started && this.activeOperations === 0) {
        const remaining = this.activityMinimumMs - (this.clock() - startedAt);
        const reportIdle = async () => {
          this.idleTimer = null;
          if (this.activeOperations === 0) await this.#reportActivity({
            state: "idle", message: "FirstMate is listening", status: "listening",
          });
        };
        if (remaining > 0) this.idleTimer = this.schedule(() => void reportIdle(), remaining);
        else await reportIdle();
      }
    }
  }

  async stop() {
    if (!this.paneId || !this.started) return;
    if (this.idleTimer !== null) {
      this.cancelScheduled(this.idleTimer);
      this.idleTimer = null;
    }
    try {
      await this.client.renameAgent?.({ paneId: this.paneId, label: null });
      await this.client.rename({ paneId: this.paneId, label: null });
      await this.client.reportMetadata({
        paneId: this.paneId,
        source: "herdr:codex",
        clearDisplayAgent: true,
        clearCustomStatus: true,
        clearStateLabels: true,
      });
      await this.client.releaseAgent({
        paneId: this.paneId,
        source: this.#source(),
        agent: "ShipMates FirstMate",
        seq: this.#next(),
      });
      this.started = false;
    } catch (error) {
      this.onWarning(`Herdr FirstMate session release unavailable: ${safeErrorName(error)}`);
    }
  }

  async #report({ state, message, status }) {
    await this.client.reportAgent({
      paneId: this.paneId,
      source: this.#source(),
      agent: "ShipMates FirstMate",
      state,
      message,
      customStatus: status,
      seq: this.#next(),
      agentSessionId: this.sessionId,
      agentSessionPath: this.repoPath,
    });
    if (typeof this.client.reportMetadata === "function") {
      try {
        await this.client.reportMetadata({
          paneId: this.paneId,
          source: "herdr:codex",
          displayAgent: "ShipMates FirstMate",
          customStatus: status,
          stateLabels: { unknown: status, idle: status, working: status },
        });
      } catch (error) {
        this.onWarning(`Herdr FirstMate activity decoration unavailable: ${safeErrorName(error)}`);
      }
    }
  }

  async #reportActivity(activity) {
    if (!this.started) return;
    try {
      await this.#report(activity);
    } catch (error) {
      this.onWarning(`Herdr FirstMate activity unavailable: ${safeErrorName(error)}`);
    }
  }

  async #verifyPaneOwnership() {
    if (typeof this.client.processInfo !== "function") return;
    const info = await this.client.processInfo(this.paneId);
    const firstmateOwnsPane = info.foregroundProcesses.some(({ argv }) =>
      argv.join(" ").includes("scripts/firstmate.js"));
    if (!firstmateOwnsPane) throw new Error("HERDR_PANE_ID does not contain FirstMate");
  }

  #next() {
    this.sequence += 1;
    return this.sequence;
  }

  #source() {
    return `shipmates:firstmate:interactive:${this.paneId}:${this.sessionId}`;
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
    this.activeWorkers = new Map();
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
      await this.#decorate({
        paneId: this.currentPaneId,
        source: `shipmates:firstmate:${taskId}`,
        displayAgent: "ShipMates FirstMate",
        status: customStatus,
        seq: this.sequences.get("firstmate"),
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
    this.activeWorkers.set(workerId, sandbox);
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
    this.activeWorkers.delete(workerId);
    await this.#workerReport(workerId, {
      state: "idle",
      message: `${workerId} ${report?.status || "completed"}`,
      customStatus: "completed",
    });
  }

  async workerFailed({ workerId, error }) {
    this.activeWorkers.delete(workerId);
    await this.#workerReport(workerId, {
      state: "blocked",
      message: `${workerId} failed (${safeErrorName(error)})`,
      customStatus: "failed",
    });
  }

  async heartbeat({ phase = "working" } = {}) {
    await Promise.all([...this.activeWorkers.keys()].map((workerId) =>
      this.#workerReport(workerId, {
        state: "working",
        message: `${workerId} is still active`,
        customStatus: phase,
      })));
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
      await this.#decorate({
        paneId: this.currentPaneId,
        source: `shipmates:firstmate:${this.taskId}`,
        displayAgent: "ShipMates FirstMate",
        status: new Set(["failed", "awaiting-human"]).has(status) ? status : "listening",
        seq: this.sequences.get("firstmate"),
      });
    } catch (error) {
      this.#warn(error);
    }
  }

  async #workerReport(workerId, { state, message, customStatus }) {
    if (this.disabled) return;
    const paneId = this.panes.get(workerId);
    if (!paneId) return;
    await this.#bestEffort(async () => {
      const source = `shipmates:worker:${this.taskId}:${workerId}`;
      const seq = this.#next(workerId);
      await this.client.reportAgent({
        paneId,
        source,
        agent: `ShipMates ${workerId}`,
        state,
        message: sanitizeStatus(message),
        customStatus: sanitizeStatus(customStatus),
        seq,
        agentSessionId: workerId,
        agentSessionPath: this.repoPath,
      });
      await this.#decorate({
        paneId, source, displayAgent: `ShipMates ${workerId}`,
        status: customStatus, seq,
      });
    });
  }

  async #release(workerId) {
    const paneId = this.panes.get(workerId);
    if (!paneId) return;
    try {
      const source = `shipmates:worker:${this.taskId}:${workerId}`;
      if (typeof this.client.reportMetadata === "function") {
        await this.client.reportMetadata({
          paneId, source, appliesToSource: "herdr:codex",
          clearDisplayAgent: true, clearCustomStatus: true, clearStateLabels: true,
          seq: this.#next(workerId),
        });
      }
      await this.client.releaseAgent({
        paneId,
        source,
        agent: `ShipMates ${workerId}`,
        seq: this.#next(workerId),
      });
    } catch (error) {
      this.#warn(error);
    } finally {
      this.panes.delete(workerId);
    }
  }

  async #decorate({ paneId, source, displayAgent, status, seq }) {
    if (typeof this.client.reportMetadata !== "function") return;
    await this.client.reportMetadata({
      paneId,
      source,
      appliesToSource: "herdr:codex",
      displayAgent,
      customStatus: sanitizeStatus(status),
      stateLabels: {
        unknown: sanitizeStatus(status), idle: "idle", working: "working", blocked: "blocked",
      },
      seq,
    });
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
