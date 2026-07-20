export class TaskProgressRecorder {
  constructor({ store, taskId, actor = "firstmate", idFactory } = {}) {
    if (!store || !taskId || typeof idFactory !== "function") {
      throw new TypeError("TaskProgressRecorder requires store, taskId, and idFactory");
    }
    this.store = store;
    this.taskId = taskId;
    this.actor = actor;
    this.idFactory = idFactory;
    this.sequence = 0;
  }

  async record({ phase, step, message, status = "running", operationId = null }) {
    this.sequence += 1;
    const progress = {
      phase: bounded(phase, 40),
      step: bounded(step, 80),
      message: bounded(message, 240),
      status: normalizeStatus(status),
      sequence: this.sequence,
      ...(operationId ? { operationId: bounded(operationId, 120) } : {}),
    };
    await this.store.recordEvidence({
      taskId: this.taskId,
      actor: this.actor,
      kind: "task-progress",
      value: JSON.stringify(progress),
      eventId: `${this.taskId}:progress:${this.idFactory()}`,
    });
    return progress;
  }
}

function bounded(value, limit) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return (text || "unknown").slice(0, limit);
}

function normalizeStatus(value) {
  return new Set(["pending", "running", "completed", "failed", "skipped"]).has(value)
    ? value : "running";
}
