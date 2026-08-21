const TERMINAL = new Set(["completed", "blocked"]);

export class WorkflowRunError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "WorkflowRunError";
  }
}

export function reduceWorkflowRun(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new WorkflowRunError("A WorkflowRun requires at least one event");
  }
  let run = null;
  const eventIds = new Set();
  for (const event of events) {
    validateEvent(event);
    if (eventIds.has(event.id)) continue;
    eventIds.add(event.id);
    run = applyEvent(run, event);
  }
  return Object.freeze({ ...run, eventCount: eventIds.size });
}

function applyEvent(run, event) {
  if (!run) {
    if (event.type !== "workflow.created") {
      throw new WorkflowRunError("The first WorkflowRun event must be workflow.created");
    }
    return {
      id: event.runId,
      phase: "awaiting_approval",
      request: event.data.request,
      plan: event.data.plan,
      repoPath: event.data.repoPath,
      baseHeadSha: event.data.baseHeadSha,
      authority: event.data.authority,
      worker: null,
      validation: null,
      retries: [],
      outcome: null,
      blocker: null,
      updatedAt: event.at,
    };
  }
  if (event.runId !== run.id) throw new WorkflowRunError("WorkflowRun event has the wrong run id");
  if (TERMINAL.has(run.phase)) throw new WorkflowRunError(`Cannot advance a ${run.phase} WorkflowRun`);
  const next = { ...run, updatedAt: event.at };
  switch (event.type) {
    case "workflow.approved":
      requirePhase(run, "awaiting_approval", event);
      if (run.authority !== "local_write") throw new WorkflowRunError("Stage 1 only approves local_write runs");
      next.phase = "approved";
      next.approvedAt = event.at;
      return next;
    case "worker.launch_requested":
      requirePhase(run, "approved", event);
      next.phase = "launching";
      next.worker = { operationId: event.data.operationId, status: "requested" };
      return next;
    case "worker.launched":
      requirePhase(run, "launching", event);
      requireOperation(run.worker, event);
      next.phase = "implementing";
      next.worker = { ...run.worker, status: "launched", receipt: event.data.receipt };
      return next;
    case "worker.completed":
      requirePhase(run, "implementing", event);
      requireOperation(run.worker, event);
      if (event.data.report?.status !== "completed") {
        throw new WorkflowRunError("Only a completed Implementer report can advance to validation");
      }
      requireHead(event.data.headSha);
      next.phase = "worker_complete";
      next.worker = {
        ...run.worker, status: "completed", report: event.data.report,
        workspacePath: event.data.workspacePath, headSha: event.data.headSha,
      };
      return next;
    case "validation.requested":
      requirePhase(run, "worker_complete", event);
      if (event.data.headSha !== run.worker.headSha) {
        throw new WorkflowRunError("Validation must target the Implementer's exact head");
      }
      next.phase = "validating";
      next.validation = {
        operationId: event.data.operationId, status: "requested",
        headSha: event.data.headSha, intent: event.data.intent,
      };
      return next;
    case "validation.observed":
      requirePhase(run, "validating", event);
      requireOperation(run.validation, event);
      if (event.data.headSha !== run.validation.headSha) {
        throw new WorkflowRunError("Observed validation head does not match the requested head");
      }
      next.validation = {
        ...run.validation, status: event.data.status, report: event.data.report,
        ...(event.data.visibility ? { visibility: event.data.visibility } : {}),
      };
      if (event.data.status === "passed") {
        next.phase = "validated";
      } else if (event.data.status === "failed") {
        next.phase = "blocked";
        next.blocker = "Validation found an unresolved problem";
      } else {
        throw new WorkflowRunError("Validation observation must be terminal");
      }
      return next;
    case "validation.review_requested":
      requirePhase(run, "validating", event);
      requireOperation(run.validation, event);
      if (event.data.headSha !== run.validation.headSha || !event.data.validatorRunId) {
        throw new WorkflowRunError("Validation review must match the exact requested run and head");
      }
      next.phase = "awaiting_validation_decision";
      next.validation = {
        ...run.validation, status: "awaiting_decision",
        validatorRunId: event.data.validatorRunId,
        review: event.data.review,
      };
      return next;
    case "validation.review_approved":
      requirePhase(run, "awaiting_validation_decision", event);
      requireOperation(run.validation, event);
      if (event.data.headSha !== run.validation.headSha ||
        event.data.validatorRunId !== run.validation.validatorRunId) {
        throw new WorkflowRunError("Validation approval does not match the pinned run and head");
      }
      next.phase = "validating";
      next.validation = { ...run.validation, status: "decision_approved", decisionAt: event.at };
      return next;
    case "operation.retry_recorded": {
      const operation = activeOperation(run);
      if (!operation || event.data.operationId !== operation.operationId ||
        !new Set(["worker", "validator"]).has(event.data.component)) {
        throw new WorkflowRunError("Safe retry must match the active durable operation");
      }
      if (run.retries.some(({ operationId }) => operationId === event.data.operationId)) {
        throw new WorkflowRunError("A durable operation can be retried only once");
      }
      next.retries = [...run.retries, {
        operationId: event.data.operationId,
        component: event.data.component,
        reason: event.data.reason,
        at: event.at,
      }];
      return next;
    }
    case "workflow.completed":
      requirePhase(run, "validated", event);
      next.phase = "completed";
      next.outcome = "passed";
      next.completedAt = event.at;
      return next;
    case "workflow.blocked":
      next.phase = "blocked";
      next.blocker = event.data.reason;
      next.blockedFrom = run.phase;
      return next;
    default:
      throw new WorkflowRunError(`Unsupported WorkflowRun event: ${event.type}`);
  }
}

function activeOperation(run) {
  if (new Set(["launching", "implementing"]).has(run.phase)) return run.worker;
  if (new Set(["validating", "awaiting_validation_decision"]).has(run.phase)) {
    return run.validation;
  }
  return null;
}

function validateEvent(event) {
  if (!event || typeof event !== "object" || !event.id || !event.runId || !event.type || !event.at) {
    throw new WorkflowRunError("Malformed WorkflowRun event");
  }
}

function requirePhase(run, phase, event) {
  if (run.phase !== phase) throw new WorkflowRunError(`${event.type} requires phase ${phase}, not ${run.phase}`);
}

function requireOperation(operation, event) {
  if (!operation || event.data.operationId !== operation.operationId) {
    throw new WorkflowRunError(`${event.type} does not match its durable operation intent`);
  }
}

function requireHead(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new WorkflowRunError("WorkflowRun requires an exact Git head SHA");
  }
}
