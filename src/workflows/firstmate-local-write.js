import { TreehouseLedgerWorkflow } from "./treehouse-ledger.js";

export async function prepareFirstmateLocalWrite({
  store, manager, taskId, requestId, repoPath, actor = "firstmate",
}) {
  if (!store || !manager) {
    throw new TypeError("Durable local-write preparation requires store and manager");
  }
  let snapshot = await store.getSnapshot(taskId);
  if (snapshot.state === "clarified") {
    snapshot = await store.transition({
      taskId,
      from: "clarified",
      to: "approved_for_dispatch",
      actor,
      reason: "Local-write classification authorizes isolated workspace preparation",
      eventId: `firstmate-${requestId}-local-write-dispatch-approved`,
    });
  }
  if (!new Set(["approved_for_dispatch", "preparing", "running"]).has(snapshot.state)) {
    throw new FirstmateLocalWriteRecoveryRequiredError(
      `Durable local-write execution cannot resume from ${snapshot.state}; run restart reconciliation`,
    );
  }
  return new TreehouseLedgerWorkflow({ store, manager, actor }).acquire({
    taskId,
    repoPath,
  });
}

export class FirstmateLocalWriteRecoveryRequiredError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "FirstmateLocalWriteRecoveryRequiredError";
  }
}
