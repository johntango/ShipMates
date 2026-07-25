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
      commit: validation.finalHeadSha || validation.headSha || validation.commitSha || null,
      outcome: validation.outcome || null,
    }) : null,
    delivery,
  });
}

function deriveBlocker(snapshot, validation) {
  if (validation?.gate?.status === "awaiting_approval") {
    return blocker(snapshot, "validation_approval_required");
  }
  if (validation?.passed === false) return blocker(snapshot, "validation_failed");
  const worker = [...(snapshot.workers || [])].reverse().find(({ failure, report }) =>
    failure || report?.status === "blocked");
  if (worker?.failure) return blocker(snapshot, "worker_failed", { workerId: worker.id });
  if (worker?.report?.status === "blocked") {
    return blocker(snapshot, "worker_blocked", { workerId: worker.id });
  }
  return new Set(["blocked", "failed", "recovery_required"]).has(snapshot.state)
    ? blocker(snapshot, `lifecycle_${snapshot.state}`)
    : null;
}

function blocker(snapshot, reason, details = {}) {
  return Object.freeze({ state: snapshot.state, reason, ...details });
}

function deriveDelivery(snapshot) {
  const local = [...(snapshot.evidence || [])].reverse().find(({ kind }) => kind === "local-delivery");
  const merge = [...(snapshot.githubMerges || [])].reverse().find(({ status }) => status === "completed");
  const localDestination = parseLocalDestination(local?.value);
  if (localDestination) {
    return Object.freeze({ kind: "local", destination: localDestination, operationId: null });
  }
  if (merge) return Object.freeze({
    kind: "github",
    destination: Object.freeze({
      repository: merge.result?.repository || merge.repository || null,
      pullRequest: merge.result?.prNumber || merge.prNumber || null,
      commit: merge.result?.mergeCommitSha || merge.mergeCommitSha || null,
    }),
    operationId: merge.operationId,
  });
  return null;
}

function parseLocalDestination(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed?.repoPath !== "string" || typeof parsed?.headSha !== "string") return null;
    return Object.freeze({ repository: parsed.repoPath, commit: parsed.headSha });
  } catch {
    return null;
  }
}

function sanitizeObservations(observations) {
  const fields = {
    worker: ["status", "pid", "workerId", "threadId"],
    worktree: ["state", "status", "leaseHolder", "headSha", "branch"],
    repository: ["status", "path", "headSha", "branch", "dirty"],
    pullRequest: ["status", "number", "url", "state", "draft", "merged", "mergeable", "headSha"],
    checks: ["status", "conclusion", "headSha", "satisfied", "pending", "failed"],
  };
  const allowed = {};
  for (const [name, names] of Object.entries(fields)) {
    if (observations[name] && typeof observations[name] === "object") {
      const projected = {};
      for (const field of names) {
        const value = observations[name][field];
        if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
          projected[field] = value;
        }
      }
      allowed[name] = Object.freeze(projected);
    }
  }
  return Object.freeze(allowed);
}
