import { ReconciliationEngine } from "../reconciliation/reconciliation-engine.js";

export function projectOperationalState({
  snapshot, observations = {}, projectTask = null,
  reconciliationEngine = new ReconciliationEngine(), source = "projection",
} = {}) {
  if (!snapshot || typeof snapshot.id !== "string") {
    throw new TypeError("Operational projection requires a task snapshot");
  }
  const validation = snapshot.validationRuns?.at(-1) || null;
  const delivery = deriveDelivery(snapshot);
  const blocker = deriveBlocker(snapshot, validation);
  return Object.freeze({
    schemaVersion: 1,
    authoritative: Object.freeze({
      taskId: snapshot.id, state: snapshot.state,
      eventsCount: snapshot.eventsCount ?? null,
      lastEventId: snapshot.lastEventId ?? null,
      lastEventAt: snapshot.lastEventAt ?? null,
    }),
    observations: sanitizeObservations(observations),
    blocker,
    recovery: reconciliationEngine.plan({ snapshot, projectTask, observations, source }),
    validation: validation ? Object.freeze({
      status: validation.gate?.status === "awaiting_approval" ? "awaiting_approval"
        : validation.passed === true ? "passed" : validation.passed === false ? "failed" : "unknown",
      commit: validation.headSha || validation.commitSha || null,
      outcome: validation.outcome || null,
    }) : null,
    delivery,
  });
}

function deriveBlocker(snapshot, validation) {
  const worker = [...(snapshot.workers || [])].reverse().find(({ failure, report }) =>
    failure || report?.status === "blocked");
  const reason = validation?.findings?.find(({ message }) => message)?.message ||
    worker?.failure?.message || worker?.failure || worker?.report?.summary ||
    (new Set(["blocked", "failed", "recovery_required"]).has(snapshot.state)
      ? `Task is ${snapshot.state.replaceAll("_", " ")}` : null);
  return reason ? Object.freeze({ state: snapshot.state, reason: String(reason) }) : null;
}

function deriveDelivery(snapshot) {
  const local = [...(snapshot.evidence || [])].reverse().find(({ kind }) => kind === "local-delivery");
  const merge = [...(snapshot.githubMerges || [])].reverse().find(({ status }) => status === "completed");
  if (local) return Object.freeze({ kind: "local", destination: local.value, operationId: null });
  if (merge) return Object.freeze({
    kind: "github", destination: merge.result?.mergeCommitSha || merge.mergeCommitSha || null,
    operationId: merge.operationId,
  });
  return null;
}

function sanitizeObservations(observations) {
  const allowed = {};
  for (const name of ["worker", "worktree", "repository", "pullRequest", "checks"]) {
    if (observations[name] && typeof observations[name] === "object") {
      allowed[name] = Object.freeze({ ...observations[name] });
    }
  }
  return Object.freeze(allowed);
}
