export const NO_MISTAKES_GATE_ENV = "NO_MISTAKES_GATE";

const containedActions = new Set([
  "worker.start",
  "worker.manage",
  "fleet.mutate",
  "branch.edit",
  "branch.rebase",
  "branch.push",
]);

export class NoMistakesController {
  constructor({ env = process.env } = {}) {
    this.contained = env[NO_MISTAKES_GATE_ENV] === "1";
  }

  gateEnvironment(env = process.env) {
    return { ...env, [NO_MISTAKES_GATE_ENV]: "1" };
  }

  assertAllowed(action, { snapshot = null } = {}) {
    if (this.contained && containedActions.has(action)) {
      throw new NoMistakesControllerRefusal(
        action,
        "no_mistakes_containment",
        "ShipMates controller authority is disabled inside a No Mistakes gate",
      );
    }
    const custody = branchCustody(snapshot);
    if (action.startsWith("branch.") && custody.owned) {
      throw new NoMistakesControllerRefusal(
        action,
        "no_mistakes_branch_custody",
        `No Mistakes AXI run ${custody.runId || custody.attemptId} owns the branch pipeline`,
      );
    }
    return custody;
  }
}

export class NoMistakesControllerRefusal extends Error {
  constructor(action, invariant, reason) {
    super(`${action} refused: invariant ${invariant} failed — ${reason}`);
    this.name = "NoMistakesControllerRefusal";
    this.action = action;
    this.invariant = invariant;
    this.reason = reason;
  }
}

export function branchCustody(snapshot) {
  const request = snapshot?.validationRequests?.at(-1);
  if (!request) return Object.freeze({ owned: false, status: "unsubmitted" });
  const report = snapshot.validationRuns?.at(-1);
  const sameRun = report && (!request.runId || request.runId === report.runId);
  if (request.status === "requested") {
    return Object.freeze({
      owned: true,
      status: "submitted",
      attemptId: request.attemptId,
      runId: request.runId || null,
    });
  }
  if (request.status === "completed" && sameRun) {
    if (report.gate?.status === "awaiting_approval") {
      return Object.freeze({
        owned: true,
        status: "awaiting_user",
        attemptId: request.attemptId,
        runId: report.runId,
      });
    }
    if (report.outcome) {
      return Object.freeze({
        owned: false,
        status: "released",
        attemptId: request.attemptId,
        runId: report.runId,
      });
    }
  }
  return Object.freeze({
    owned: true,
    status: "recovery_required",
    attemptId: request.attemptId,
    runId: request.runId || report?.runId || null,
  });
}
