export function authorizeFirstmateDispatch({ requiredAuthority, project, plannedTask = null }) {
  if (requiredAuthority === "read_only") {
    return { mode: "read_only", trackProjectAttempt: false };
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
  if (authorizedAuthority && classifiedAuthority !== authorizedAuthority) {
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
  constructor({ store, actor = "firstmate" } = {}) {
    if (!store) throw new TypeError("ReadOnlyInspectionTracker requires a task store");
    this.store = store;
    this.actor = actor;
  }

  async prepare({ taskId, requestId, repo, baseSha, project }) {
    authorizeFirstmateDispatch({ requiredAuthority: "read_only", project });
    await this.store.createTask({
      taskId, kind: "firstmate-intake", repo, baseSha, actor: this.actor,
      eventId: `firstmate-${requestId}-task-created`,
    });
    await this.store.recordEvidence({
      taskId, actor: this.actor, kind: "read-only-dispatch-intent",
      value: JSON.stringify({ requestId, authority: "read_only" }),
      eventId: `firstmate-${requestId}-read-only-dispatch-intent`,
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

  async reconcileCompleted() {
    const results = [];
    for (const taskId of await this.store.listTaskIds()) {
      const snapshot = await this.store.getSnapshot(taskId);
      const intent = latestEvidence(snapshot, "read-only-dispatch-intent");
      if (!intent) continue;
      const requestId = intent.requestId;
      if (!requestId || evidenceValue(snapshot, "read-only-inspection-terminal", requestId)) continue;
      const execution = evidenceValue(snapshot, "firstmate-local-execution", requestId);
      if (!execution) continue;
      results.push(await this.reconcile({
        taskId, requestId,
        exitCode: execution.status === "inspected" ? 0 : 1,
      }));
    }
    return results;
  }
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
