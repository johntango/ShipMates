import { classifyTaskRecovery } from "../workflows/task-recovery.js";

export const RECONCILIATION_DECISIONS = Object.freeze([
  "no_action",
  "record_observed_completion",
  "resume_existing_validation",
  "retry_delivery",
  "mark_worker_lost",
  "return_verified_lease",
  "request_human_approval",
  "require_manual_repair",
]);

const deliveryCollections = Object.freeze([
  "gitPushes", "githubDraftPullRequests", "githubMerges", "branchCleanups",
]);

export class ReconciliationEngine {
  plan({ snapshot, projectTask = null, observations = {}, source = "unspecified" } = {}) {
    const recovery = classifyTaskRecovery(snapshot);
    const context = {
      taskId: snapshot.id,
      source,
      observedEventId: snapshot.lastEventId || null,
      observedEventsCount: snapshot.eventsCount ?? null,
      recoveryCategory: recovery.category,
    };

    if (snapshot.state === "complete") {
      return projectTask && projectTask.status !== "completed"
        ? result("record_observed_completion", recovery.reason, true, context)
        : result("no_action", recovery.reason, true, context);
    }

    if (recovery.category === "validation_approval_required") {
      return result("request_human_approval", recovery.reason, true, context);
    }
    if (recovery.category === "validation_uncertain") {
      return result("resume_existing_validation", recovery.reason, true, context);
    }

    const pendingDelivery = findPendingDelivery(snapshot);
    if (pendingDelivery) {
      return result("retry_delivery", `${pendingDelivery.kind} has durable intent without a terminal receipt`, true, {
        ...context, operationId: pendingDelivery.operation.operationId || null,
      });
    }

    if (snapshot.worktree?.status === "return_requested") {
      const verified = observations.worktree?.state === "available" &&
        observations.worktree?.leaseHolder === null;
      return verified
        ? result("return_verified_lease", "The requested lease return is independently verified", true, context)
        : result("require_manual_repair", "Lease return is uncertain and has not been independently verified", false, context);
    }

    if (recovery.category === "worker_uncertain") {
      if (observations.worker?.status === "missing" || observations.worker?.status === "exited") {
        return result("mark_worker_lost", "The durable worker attempt has no report and the process is absent", true, context);
      }
      return observations.worker?.status === "running"
        ? result("no_action", "The existing worker is still running", true, context)
        : result("require_manual_repair", recovery.reason, false, context);
    }

    return result("require_manual_repair", recovery.reason, false, context);
  }
}

function findPendingDelivery(snapshot) {
  for (const kind of deliveryCollections) {
    const operation = snapshot[kind]?.at(-1);
    if (operation?.status === "requested") return { kind, operation };
  }
  return null;
}

function result(decision, reason, safeToApply, evidence) {
  if (!RECONCILIATION_DECISIONS.includes(decision)) {
    throw new Error(`Unsupported reconciliation decision ${decision}`);
  }
  return Object.freeze({ decision, reason, safeToApply, evidence: Object.freeze(evidence) });
}
