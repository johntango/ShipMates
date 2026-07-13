export class LocalValidationWorkflow {
  constructor({ store, gate, actor = "firstmate" } = {}) {
    if (!store || !gate) {
      throw new TypeError("LocalValidationWorkflow requires store and gate");
    }
    this.store = store;
    this.gate = gate;
    this.actor = actor;
  }

  async run({ taskId, intent }) {
    const snapshot = await this.store.getSnapshot(taskId);
    if (snapshot.state !== "validating" || snapshot.worktree?.status !== "leased") {
      throw new LocalValidationWorkflowError(
        "Local validation requires a validating task with an active lease",
      );
    }
    const report = await this.gate.run({
      taskId,
      worktreePath: snapshot.worktree.worktreePath,
      expectedHeadSha: snapshot.worktree.headSha,
      intent,
    });
    return this.store.recordLocalValidation({
      taskId,
      actor: this.actor,
      report,
      eventId: `${taskId}:validation:${report.runId}:v1`,
      at: report.completedAt,
    });
  }
}

export class LocalValidationWorkflowError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "LocalValidationWorkflowError";
  }
}
