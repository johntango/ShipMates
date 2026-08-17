import { execFileSync } from "node:child_process";

export function authorizeFirstmateDispatch({ requiredAuthority, project, plannedTask = null }) {
  if (requiredAuthority === "read_only") {
    if (plannedTask && (!project || project.status !== "approved" || plannedTask.status !== "claimed")) {
      throw new FirstmateDispatchPolicyError(
        "Planned read-only dispatch requires an approved project plan and governed claimed task",
      );
    }
    return { mode: "read_only", trackProjectAttempt: Boolean(plannedTask) };
  }
  if (requiredAuthority === "local_write") {
    if (!project || project.status !== "approved" || !plannedTask || plannedTask.status !== "claimed") {
      throw new FirstmateDispatchPolicyError(
        "Implementation dispatch requires an approved project plan and governed claimed task",
      );
    }
    return { mode: "implementation", trackProjectAttempt: true };
  }
  throw new FirstmateDispatchPolicyError(
    `Firstmate cannot dispatch ${requiredAuthority || "unclassified"} work without its separate approval workflow`,
  );
}

export function verifyAuthorizedClassification(authorizedAuthority, classifiedAuthority) {
  const safeNarrowing = authorizedAuthority === "local_write" &&
    classifiedAuthority === "read_only";
  if (authorizedAuthority && classifiedAuthority !== authorizedAuthority && !safeNarrowing) {
    throw new FirstmateDispatchPolicyError(
      `Firstmate refused dispatch because authorized ${authorizedAuthority} work was classified as ${classifiedAuthority}`,
    );
  }
}

export class FirstmateDispatchPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "FirstmateDispatchPolicyError";
  }
}

export class ReadOnlyInspectionTracker {
  constructor({
    store, actor = "firstmate", isReceiptLive = defaultReceiptLiveness,
    findReceipt = findProcessReceipt,
  } = {}) {
    if (!store) throw new TypeError("ReadOnlyInspectionTracker requires a task store");
    this.store = store;
    this.actor = actor;
    this.isReceiptLive = isReceiptLive;
    this.findReceipt = findReceipt;
  }

  async prepare({ taskId, requestId, repo, baseSha, project }) {
    authorizeFirstmateDispatch({ requiredAuthority: "read_only", project });
    await this.store.withExclusiveLock("firstmate-read-only-dispatch", async () => {
      const outstanding = await this.outstanding();
      if (outstanding.length) {
        throw new FirstmateDispatchPolicyError(
          `Read-only inspection ${outstanding[0].taskId} is still outstanding; Firstmate is monitoring it before allowing a retry`,
        );
      }
      await this.store.createTask({
        taskId, kind: "firstmate-intake", repo, baseSha, actor: this.actor,
        eventId: `firstmate-${requestId}-task-created`,
      });
      await this.store.recordEvidence({
        taskId, actor: this.actor, kind: "read-only-dispatch-intent",
        value: JSON.stringify({ requestId, authority: "read_only" }),
        eventId: `firstmate-${requestId}-read-only-dispatch-intent`,
      });
    });
  }

  async recordReceipt({ taskId, requestId, receipt }) {
    await this.store.recordEvidence({
      taskId, actor: this.actor, kind: "read-only-launch-receipt",
      value: JSON.stringify(receipt),
      eventId: `firstmate-${requestId}-read-only-launch-receipt`,
    });
  }

  async reconcile({ taskId, requestId, exitCode = null, signal = null }) {
    const snapshot = await this.store.getSnapshot(taskId);
    const execution = evidenceValue(snapshot, "firstmate-local-execution", requestId);
    const prior = evidenceValue(snapshot, "read-only-inspection-terminal", requestId);
    if (prior) return { snapshot, terminal: prior, recovered: true };

    const succeeded = execution?.status === "inspected" && exitCode !== null && exitCode === 0;
    const terminal = {
      requestId,
      status: succeeded ? "completed" : "failed",
      executionStatus: execution?.status || null,
      exitCode,
      signal,
      reason: succeeded ? null : terminalReason({ execution, exitCode, signal }),
    };
    const reconciled = await this.store.recordEvidence({
      taskId, actor: this.actor, kind: "read-only-inspection-terminal",
      value: JSON.stringify(terminal),
      eventId: `firstmate-${requestId}-read-only-inspection-terminal`,
    });
    return { snapshot: reconciled, terminal, recovered: false };
  }

  async reconcileInterrupted() {
    return this.store.withExclusiveLock("firstmate-read-only-dispatch", async () => {
      const results = [];
      for (const item of await this.outstanding()) {
        const execution = evidenceValue(item.snapshot, "firstmate-local-execution", item.requestId);
        let receipt = evidenceValue(item.snapshot, "read-only-launch-receipt", item.requestId);
        if (!execution && !receipt) {
          receipt = await this.findReceipt(item.requestId);
          if (receipt) await this.recordReceipt({
            taskId: item.taskId, requestId: item.requestId, receipt,
          });
        }
        if (!execution && receipt && await this.isReceiptLive(receipt)) {
          results.push({ ...item, receipt, live: true });
          continue;
        }
        results.push({ ...await this.reconcile({
          taskId: item.taskId, requestId: item.requestId,
          exitCode: execution?.status === "inspected" ? 0 : 1,
        }), live: false });
      }
      return results;
    });
  }

  monitorRecovered({ taskId, requestId, receipt, intervalMs = 1_000, onTerminal = () => {} }) {
    const poll = async () => {
      if (await this.isReceiptLive(receipt)) {
        const timer = setTimeout(() => void poll(), intervalMs);
        timer.unref?.();
        return;
      }
      const snapshot = await this.store.getSnapshot(taskId);
      const execution = evidenceValue(snapshot, "firstmate-local-execution", requestId);
      const result = await this.reconcile({
        taskId, requestId, exitCode: execution?.status === "inspected" ? 0 : 1,
      });
      await onTerminal(result);
    };
    void poll();
  }

  async outstanding() {
    const results = [];
    for (const taskId of await this.store.listTaskIds()) {
      const snapshot = await this.store.getSnapshot(taskId);
      const intent = latestEvidence(snapshot, "read-only-dispatch-intent");
      if (!intent?.requestId || evidenceValue(
        snapshot, "read-only-inspection-terminal", intent.requestId,
      )) continue;
      results.push({ taskId, requestId: intent.requestId, snapshot });
    }
    return results;
  }
}

function defaultReceiptLiveness(receipt) {
  return isProcessReceiptLive(receipt);
}

export function isProcessReceiptLive(receipt, {
  signalProcess = (pid) => process.kill(pid, 0),
  readCommand = readProcessCommand,
} = {}) {
  if (receipt?.kind !== "process" || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0 ||
    typeof receipt.commandToken !== "string" || !receipt.commandToken) {
    return false;
  }
  try {
    signalProcess(receipt.pid);
    return readCommand(receipt.pid).includes(receipt.commandToken);
  } catch (error) {
    return false;
  }
}

export function readProcessCommand(pid, execute = execFileSync) {
  return execute("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
  });
}

export function findProcessReceipt(commandToken, execute = execFileSync) {
  if (typeof commandToken !== "string" || !commandToken) return null;
  const processes = execute("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
  for (const line of processes.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u);
    if (match?.[2].includes(commandToken)) {
      return { kind: "process", pid: Number(match[1]), commandToken };
    }
  }
  return null;
}

function evidenceValue(snapshot, kind, requestId) {
  const matches = (snapshot.evidence || []).filter((item) => item.kind === kind);
  for (const item of matches.toReversed()) {
    try {
      const value = JSON.parse(item.value);
      if (!requestId || value.requestId === requestId) return value;
    } catch { /* Ignore malformed historical evidence and keep searching. */ }
  }
  return null;
}

function latestEvidence(snapshot, kind) {
  return evidenceValue(snapshot, kind, null);
}

function terminalReason({ execution, exitCode, signal }) {
  if (execution?.failure?.message) return execution.failure.message;
  if (signal) return `Worker exited after signal ${signal}`;
  if (exitCode !== null) return `Worker exited with code ${exitCode}`;
  return "Worker stopped without durable completion evidence";
}
