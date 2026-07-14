import { createHash } from "node:crypto";

export const TASK_STATES = Object.freeze([
  "proposed",
  "clarified",
  "approved_for_dispatch",
  "preparing",
  "running",
  "awaiting_worker",
  "validating",
  "awaiting_human",
  "ready_to_merge",
  "merging",
  "landed",
  "cleaning",
  "complete",
  "blocked",
  "failed",
  "cancelled",
  "recovery_required",
]);

const exceptionalStates = [
  "blocked",
  "failed",
  "cancelled",
  "recovery_required",
];

const normalTransitions = {
  proposed: ["clarified"],
  clarified: ["approved_for_dispatch"],
  approved_for_dispatch: ["preparing"],
  preparing: ["running"],
  running: ["awaiting_worker", "validating"],
  awaiting_worker: ["running", "validating"],
  validating: ["awaiting_human", "running", "cleaning"],
  awaiting_human: ["ready_to_merge", "running"],
  ready_to_merge: ["merging", "running"],
  merging: ["landed"],
  landed: ["cleaning"],
  cleaning: ["complete"],
  complete: [],
  blocked: [],
  failed: [],
  cancelled: [],
  recovery_required: [],
};

export const VALID_TRANSITIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(normalTransitions).map(([from, normal]) => [
      from,
      Object.freeze(
        from === "complete" || exceptionalStates.includes(from)
          ? normal
          : [...normal, ...exceptionalStates],
      ),
    ]),
  ),
);

export function validateTaskId(taskId) {
  if (
    typeof taskId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(taskId)
  ) {
    throw new TypeError(
      "taskId must be 3-64 lowercase letters, numbers, dots, underscores, or hyphens",
    );
  }
  return taskId;
}

export function replayTaskEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new TaskStateError("A task must contain at least one event");
  }

  const snapshot = {
    schemaVersion: 1,
    id: null,
    kind: null,
    state: null,
    repo: null,
    baseSha: null,
    worktree: null,
    workers: [],
    eventsCount: 0,
    lastEventId: null,
    lastEventAt: null,
    evidence: [],
    approvals: [],
    githubObservations: [],
    githubDraftPrApprovals: [],
    githubDraftPullRequests: [],
    validationRuns: [],
    recoveryAudits: [],
    firstmateRuns: [],
    scoutSyntheses: [],
    scoutFollowUps: [],
  };
  const eventIds = new Set();

  for (const [index, event] of events.entries()) {
    validateEventEnvelope(event, index);
    if (eventIds.has(event.id)) {
      throw new TaskStateError(`Duplicate event id: ${event.id}`);
    }
    eventIds.add(event.id);

    if (snapshot.id !== null && event.taskId !== snapshot.id) {
      throw new TaskStateError(
        `Event ${event.id} belongs to ${event.taskId}, expected ${snapshot.id}`,
      );
    }
    if (
      snapshot.lastEventAt !== null &&
      Date.parse(event.at) < Date.parse(snapshot.lastEventAt)
    ) {
      throw new TaskStateError(`Event ${event.id} is out of timestamp order`);
    }

    applyEvent(snapshot, event, index);
    snapshot.eventsCount += 1;
    snapshot.lastEventId = event.id;
    snapshot.lastEventAt = event.at;
  }

  return snapshot;
}

export class TaskStateError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "TaskStateError";
  }
}

function applyEvent(snapshot, event, index) {
  switch (event.type) {
    case "task.created": {
      if (index !== 0 || snapshot.id !== null) {
        throw new TaskStateError("task.created must be the first event");
      }
      const { kind, repo, baseSha } = event.data;
      requireNonEmpty("kind", kind);
      requireNonEmpty("repo", repo);
      requireNonEmpty("baseSha", baseSha);
      snapshot.id = validateTaskId(event.taskId);
      snapshot.kind = kind;
      snapshot.repo = repo;
      snapshot.baseSha = baseSha;
      snapshot.state = "proposed";
      break;
    }

    case "task.transitioned": {
      requireCreated(snapshot, event);
      const { from, to } = event.data;
      requireNonEmpty("from", from);
      requireNonEmpty("to", to);
      if (snapshot.state !== from) {
        throw new TaskStateError(
          `Stale transition ${event.id}: expected ${snapshot.state}, received ${from}`,
        );
      }
      if (!VALID_TRANSITIONS[from]?.includes(to)) {
        throw new TaskStateError(`Invalid task transition: ${from} -> ${to}`);
      }
      if (from === "validating" && to === "awaiting_human") {
        const validation = snapshot.validationRuns.at(-1);
        if (
          validation?.passed !== true ||
          snapshot.worktree?.status !== "leased" ||
          validation.finalHeadSha !== snapshot.worktree.headSha
        ) {
          throw new TaskStateError(
            "A passing local validation for the active lease is required before human review",
          );
        }
      }
      snapshot.state = to;
      break;
    }

    case "task.evidence.recorded": {
      requireCreated(snapshot, event);
      requireNonEmpty("kind", event.data.kind);
      requireNonEmpty("value", event.data.value);
      snapshot.evidence.push({
        ...event.data,
        eventId: event.id,
        at: event.at,
        actor: event.actor,
      });
      break;
    }

    case "task.approval.recorded": {
      requireCreated(snapshot, event);
      const { repo, prNumber, headSha, mergeMethod, decision } = event.data;
      requireNonEmpty("repo", repo);
      if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
        throw new TaskStateError("prNumber must be a positive integer");
      }
      requireNonEmpty("headSha", headSha);
      requireNonEmpty("mergeMethod", mergeMethod);
      requireNonEmpty("decision", decision);
      snapshot.approvals.push({
        ...event.data,
        eventId: event.id,
        at: event.at,
        actor: event.actor,
      });
      break;
    }

    case "github.status.recorded": {
      requireCreated(snapshot, event);
      const { report } = event.data;
      validateGitHubStatusReport(snapshot, report, event);
      snapshot.githubObservations.push({
        ...report,
        eventId: event.id,
        at: event.at,
        actor: event.actor,
      });
      break;
    }

    case "github.draft_pr.approved": {
      requireCreated(snapshot, event);
      const approval = event.data;
      validateDraftPrBinding(snapshot, approval);
      requireNonEmpty("draft PR approval ID", approval.approvalId);
      if (approval.decision !== "approved" || approval.approverType !== "human") {
        throw new TaskStateError("Draft PR creation requires explicit human approval");
      }
      requirePassingActiveValidation(snapshot);
      if (snapshot.githubDraftPrApprovals.some(({ approvalId }) =>
        approvalId === approval.approvalId)) {
        throw new TaskStateError(`Draft PR approval already exists: ${approval.approvalId}`);
      }
      snapshot.githubDraftPrApprovals.push({
        ...approval,
        eventId: event.id,
        at: event.at,
        actor: event.actor,
        consumedBy: null,
      });
      break;
    }

    case "github.draft_pr.create.requested": {
      requireCreated(snapshot, event);
      const request = event.data;
      validateDraftPrBinding(snapshot, request);
      requireNonEmpty("draft PR operation ID", request.operationId);
      requireNonEmpty("draft PR approval event ID", request.approvalEventId);
      requirePassingActiveValidation(snapshot);
      const approval = snapshot.githubDraftPrApprovals.find(
        ({ eventId }) => eventId === request.approvalEventId,
      );
      if (!approval || approval.consumedBy !== null ||
        !sameDraftPrBinding(approval, request)) {
        throw new TaskStateError("Draft PR request lacks a matching unused human approval");
      }
      if (snapshot.githubDraftPullRequests.some(({ operationId }) =>
        operationId === request.operationId)) {
        throw new TaskStateError(`Draft PR operation already exists: ${request.operationId}`);
      }
      approval.consumedBy = request.operationId;
      snapshot.githubDraftPullRequests.push({
        ...request,
        status: "requested",
        requestEventId: event.id,
        pullRequest: null,
        failure: null,
      });
      break;
    }

    case "github.draft_pr.create.completed": {
      requireCreated(snapshot, event);
      const operation = requireDraftPrOperation(
        snapshot,
        event.data.operationId,
        "requested",
      );
      if (event.data.requestEventId !== operation.requestEventId) {
        throw new TaskStateError("Draft PR result does not match its request");
      }
      validateCreatedDraftPullRequest(snapshot, operation, event.data.pullRequest);
      operation.status = "completed";
      operation.pullRequest = event.data.pullRequest;
      operation.completedEventId = event.id;
      break;
    }

    case "github.draft_pr.create.failed": {
      requireCreated(snapshot, event);
      const operation = requireDraftPrOperation(
        snapshot,
        event.data.operationId,
        "requested",
      );
      if (event.data.requestEventId !== operation.requestEventId) {
        throw new TaskStateError("Draft PR failure does not match its request");
      }
      requireNonEmpty("draft PR failure", event.data.message);
      operation.status = "failed";
      operation.failure = event.data.message;
      operation.failedEventId = event.id;
      break;
    }

    case "validation.local.recorded": {
      requireCreated(snapshot, event);
      const { report } = event.data;
      validateLocalValidationReport(snapshot, report);
      snapshot.validationRuns.push({
        ...report,
        eventId: event.id,
        at: event.at,
        actor: event.actor,
      });
      break;
    }

    case "recovery.audit.recorded": {
      requireCreated(snapshot, event);
      validateRecoveryAudit(snapshot, event.data.report, event);
      snapshot.recoveryAudits.push({
        ...event.data.report,
        eventId: event.id,
        at: event.at,
      });
      break;
    }

    case "firstmate.run.requested": {
      requireCreated(snapshot, event);
      const {
        requestId,
        attemptId,
        requestSha256,
        model,
        maxTurns,
        tracingEnabled,
        storeResponse,
      } = event.data;
      requireNonEmpty("Firstmate request ID", requestId);
      requireNonEmpty("Firstmate attempt ID", attemptId);
      requireSha256("Firstmate request digest", requestSha256);
      requireNonEmpty("Firstmate model", model);
      if (!Number.isSafeInteger(maxTurns) || maxTurns !== 1) {
        throw new TaskStateError("Firstmate maxTurns must be exactly 1");
      }
      if (typeof tracingEnabled !== "boolean" || storeResponse !== false) {
        throw new TaskStateError(
          "Firstmate tracing must be explicit and response storage must be disabled",
        );
      }
      if (snapshot.firstmateRuns.some((run) => run.requestId === requestId)) {
        throw new TaskStateError(`Firstmate request already exists: ${requestId}`);
      }
      snapshot.firstmateRuns.push({
        requestId,
        attemptId,
        requestSha256,
        model,
        maxTurns,
        tracingEnabled,
        storeResponse,
        status: "requested",
        requestEventId: event.id,
        requestedAt: event.at,
        classification: null,
        usage: null,
        failure: null,
      });
      break;
    }

    case "firstmate.run.classified": {
      requireCreated(snapshot, event);
      const run = requireFirstmateRun(snapshot, event.data.requestId, "requested");
      if (event.data.requestEventId !== run.requestEventId) {
        throw new TaskStateError(
          "Firstmate classification does not match its request event",
        );
      }
      validateFirstmateClassification(snapshot, event.data.classification);
      validateFirstmateUsage(event.data.usage);
      run.status = "classified";
      run.classification = event.data.classification;
      run.usage = event.data.usage;
      run.classifiedEventId = event.id;
      run.classifiedAt = event.at;
      break;
    }

    case "firstmate.run.failed": {
      requireCreated(snapshot, event);
      const run = requireFirstmateRun(snapshot, event.data.requestId, "requested");
      if (event.data.requestEventId !== run.requestEventId) {
        throw new TaskStateError("Firstmate failure does not match its request event");
      }
      requireNonEmpty("Firstmate failure category", event.data.category);
      requireNonEmpty("Firstmate failure message", event.data.message);
      run.status = "failed";
      run.failure = {
        category: event.data.category,
        message: event.data.message,
        eventId: event.id,
        at: event.at,
      };
      break;
    }

    case "worktree.lease.requested": {
      requireCreated(snapshot, event);
      const { repoPath, baseSha } = event.data;
      requireNonEmpty("repoPath", repoPath);
      requireNonEmpty("baseSha", baseSha);
      if (snapshot.worktree !== null) {
        throw new TaskStateError("A worktree lifecycle already exists for this task");
      }
      if (baseSha !== snapshot.baseSha) {
        throw new TaskStateError(
          `Lease base ${baseSha} does not match task base ${snapshot.baseSha}`,
        );
      }
      snapshot.worktree = {
        status: "lease_requested",
        repoPath,
        baseSha,
        leaseRequestEventId: event.id,
        worktreePath: null,
        headSha: null,
        branch: null,
        proof: null,
        returnRequestEventId: null,
        returnedEventId: null,
      };
      break;
    }

    case "worktree.leased": {
      requireWorktreeStatus(snapshot, event, "lease_requested");
      const { requestEventId, repoPath, worktreePath, headSha, branch } =
        event.data;
      requireNonEmpty("requestEventId", requestEventId);
      requireNonEmpty("repoPath", repoPath);
      requireNonEmpty("worktreePath", worktreePath);
      requireNonEmpty("headSha", headSha);
      if (requestEventId !== snapshot.worktree.leaseRequestEventId) {
        throw new TaskStateError("Lease result does not match its request event");
      }
      if (repoPath !== snapshot.worktree.repoPath) {
        throw new TaskStateError("Lease result changed the requested repository path");
      }
      if (headSha !== snapshot.baseSha) {
        throw new TaskStateError("Leased worktree is not at the task base SHA");
      }
      if (branch !== null && typeof branch !== "string") {
        throw new TaskStateError("branch must be a string or null");
      }
      Object.assign(snapshot.worktree, {
        status: "leased",
        worktreePath,
        headSha,
        branch,
        leasedEventId: event.id,
      });
      break;
    }

    case "worktree.proof.recorded": {
      requireWorktreeStatus(snapshot, event, "leased");
      const { kind, verified, worktreePath, headSha } = event.data;
      requireNonEmpty("kind", kind);
      requireNonEmpty("worktreePath", worktreePath);
      requireNonEmpty("headSha", headSha);
      if (verified !== true) {
        throw new TaskStateError("A worktree proof must be verified");
      }
      requireMatchingWorktree(snapshot, worktreePath, headSha);
      snapshot.worktree.proof = {
        ...event.data,
        eventId: event.id,
        at: event.at,
        actor: event.actor,
      };
      break;
    }

    case "worktree.return.requested": {
      requireWorktreeStatus(snapshot, event, "leased");
      const { worktreePath, proofEventId } = event.data;
      requireNonEmpty("worktreePath", worktreePath);
      requireNonEmpty("proofEventId", proofEventId);
      if (
        worktreePath !== snapshot.worktree.worktreePath ||
        proofEventId !== snapshot.worktree.proof?.eventId
      ) {
        throw new TaskStateError("Worktree return request lacks its matching proof");
      }
      snapshot.worktree.status = "return_requested";
      snapshot.worktree.returnRequestEventId = event.id;
      break;
    }

    case "worktree.returned": {
      requireWorktreeStatus(snapshot, event, "return_requested");
      const { worktreePath, requestEventId } = event.data;
      requireNonEmpty("worktreePath", worktreePath);
      requireNonEmpty("requestEventId", requestEventId);
      if (
        worktreePath !== snapshot.worktree.worktreePath ||
        requestEventId !== snapshot.worktree.returnRequestEventId
      ) {
        throw new TaskStateError("Worktree return result does not match its request");
      }
      snapshot.worktree.status = "returned";
      snapshot.worktree.returnedEventId = event.id;
      break;
    }

    case "worker.dispatch.requested": {
      requireCreated(snapshot, event);
      const {
        workerId,
        backend,
        mode,
        worktreePath,
        sandbox,
        brief,
        briefSha256,
        paneId = null,
      } = event.data;
      for (const [label, value] of Object.entries({
        workerId,
        backend,
        mode,
        worktreePath,
        sandbox,
        brief,
        briefSha256,
      })) {
        requireNonEmpty(label, value);
      }
      if (paneId !== null) requireNonEmpty("paneId", paneId);
      if (
        snapshot.state !== "running" ||
        snapshot.worktree?.status !== "leased" ||
        worktreePath !== snapshot.worktree.worktreePath
      ) {
        throw new TaskStateError(
          "Worker dispatch requires a running task with its matching active lease",
        );
      }
      if (snapshot.workers.some((worker) => worker.id === workerId)) {
        throw new TaskStateError(`Worker already exists: ${workerId}`);
      }
      snapshot.workers.push({
        id: workerId,
        backend,
        mode,
        sandbox,
        worktreePath,
        brief,
        briefSha256,
        status: "dispatch_requested",
        dispatchEventId: event.id,
        threadId: null,
        report: null,
        verification: null,
        failure: null,
        replies: [],
        paneId,
      });
      break;
    }

    case "worker.started": {
      const worker = requireWorkerStatus(snapshot, event, "dispatch_requested");
      const { workerId, requestEventId, threadId } = event.data;
      requireNonEmpty("workerId", workerId);
      requireNonEmpty("requestEventId", requestEventId);
      requireNonEmpty("threadId", threadId);
      if (requestEventId !== worker.dispatchEventId) {
        throw new TaskStateError("Worker start does not match its dispatch event");
      }
      worker.status = "started";
      worker.threadId = threadId;
      worker.startedEventId = event.id;
      break;
    }

    case "worker.report.recorded": {
      const worker = requireWorkerStatus(snapshot, event, "started");
      const { workerId, threadId, report, verification } = event.data;
      if (threadId !== worker.threadId) {
        throw new TaskStateError("Worker report thread does not match worker start");
      }
      if (
        !report ||
        typeof report !== "object" ||
        report.taskId !== snapshot.id ||
        !verification ||
        verification.noMutation !== true
      ) {
        throw new TaskStateError(
          "Worker report requires the matching task and independent no-mutation verification",
        );
      }
      worker.status = "reported";
      worker.report = report;
      worker.verification = verification;
      worker.reportEventId = event.id;
      break;
    }

    case "worker.failed": {
      const worker = findWorker(snapshot, event.data.workerId);
      requireNonEmpty("message", event.data.message);
      if (!new Set(["dispatch_requested", "started"]).has(worker.status)) {
        throw new TaskStateError(`Cannot fail worker from status ${worker.status}`);
      }
      worker.status = "failed";
      worker.failure = event.data.message;
      worker.failedEventId = event.id;
      break;
    }

    case "scout.synthesis.recorded": {
      requireCreated(snapshot, event);
      const record = event.data;
      validateScoutSynthesisRecord(snapshot, record);
      if (snapshot.scoutSyntheses.some(({ synthesisId }) =>
        synthesisId === record.synthesisId)) {
        throw new TaskStateError(
          `Scout synthesis already exists: ${record.synthesisId}`,
        );
      }
      snapshot.scoutSyntheses.push({
        ...record,
        eventId: event.id,
        at: event.at,
        actor: event.actor,
      });
      break;
    }

    case "scout.follow_up.selected": {
      requireCreated(snapshot, event);
      const selection = event.data;
      validateScoutFollowUpSelection(snapshot, selection);
      if (snapshot.scoutFollowUps.some(({ followUpId }) =>
        followUpId === selection.followUpId)) {
        throw new TaskStateError(
          `Scout follow-up already exists: ${selection.followUpId}`,
        );
      }
      snapshot.scoutFollowUps.push({
        ...selection,
        status: "selected",
        selectionEventId: event.id,
        selectedAt: event.at,
        selectedBy: event.actor,
        outcome: null,
        reportSha256: null,
        counts: null,
        replyEventId: null,
        resolvedEventId: null,
        resolvedAt: null,
      });
      break;
    }

    case "worker.reply.requested": {
      const worker = findWorker(snapshot, event.data.workerId);
      const { replyId, threadId, leaseHeadSha, sandbox, promptSha256 } = event.data;
      for (const [label, value] of Object.entries({
        replyId, threadId, leaseHeadSha, sandbox, promptSha256,
      })) requireNonEmpty(label, value);
      requireIdentifier("replyId", replyId);
      requireSha256("promptSha256", promptSha256);
      if (
        worker.status !== "reported" ||
        threadId !== worker.threadId ||
        snapshot.state !== "running" ||
        snapshot.worktree?.status !== "leased" ||
        leaseHeadSha !== snapshot.worktree.headSha ||
        sandbox !== "read-only"
      ) {
        throw new TaskStateError(
          "Worker reply requires its reported thread and matching read-only active lease",
        );
      }
      worker.replies ||= [];
      if (worker.replies.some((reply) => reply.id === replyId)) {
        throw new TaskStateError(`Worker reply already exists: ${replyId}`);
      }
      worker.replies.push({
        id: replyId,
        status: "requested",
        requestEventId: event.id,
        threadId,
        leaseHeadSha,
        sandbox,
        promptSha256,
        report: null,
        verification: null,
        failure: null,
      });
      break;
    }

    case "worker.reply.completed": {
      const worker = findWorker(snapshot, event.data.workerId);
      const reply = findWorkerReply(worker, event.data.replyId);
      const { requestEventId, threadId, leaseHeadSha, report, verification } = event.data;
      if (
        reply.status !== "requested" ||
        requestEventId !== reply.requestEventId ||
        threadId !== worker.threadId ||
        threadId !== reply.threadId ||
        leaseHeadSha !== reply.leaseHeadSha ||
        snapshot.worktree?.status !== "leased" ||
        snapshot.worktree.headSha !== leaseHeadSha ||
        !report || report.taskId !== snapshot.id ||
        !verification || verification.noMutation !== true ||
        verification.headSha !== leaseHeadSha
      ) {
        throw new TaskStateError("Worker reply result does not match its durable request");
      }
      reply.status = "completed";
      reply.report = report;
      reply.verification = verification;
      reply.completedEventId = event.id;
      break;
    }

    case "worker.reply.failed": {
      const worker = findWorker(snapshot, event.data.workerId);
      const reply = findWorkerReply(worker, event.data.replyId);
      requireNonEmpty("message", event.data.message);
      if (
        reply.status !== "requested" ||
        event.data.requestEventId !== reply.requestEventId
      ) throw new TaskStateError("Worker reply failure does not match its request");
      reply.status = "failed";
      reply.failure = event.data.message;
      reply.failedEventId = event.id;
      break;
    }

    case "scout.follow_up.resolved": {
      requireCreated(snapshot, event);
      const resolution = event.data;
      const followUp = snapshot.scoutFollowUps.find(({ followUpId }) =>
        followUpId === resolution.followUpId);
      if (!followUp || followUp.status !== "selected") {
        throw new TaskStateError(
          `Scout follow-up cannot be resolved: ${resolution.followUpId}`,
        );
      }
      validateScoutFollowUpResolution(snapshot, followUp, resolution);
      Object.assign(followUp, {
        status: "resolved",
        outcome: resolution.outcome,
        reportSha256: resolution.reportSha256,
        counts: { ...resolution.counts },
        replyEventId: resolution.replyEventId,
        resolvedEventId: event.id,
        resolvedAt: event.at,
      });
      break;
    }

    default:
      throw new TaskStateError(`Unknown event type: ${event.type}`);
  }
}

function validateScoutSynthesisRecord(snapshot, record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TaskStateError("Scout synthesis record must be an object");
  }
  const expectedKeys = [
    "artifactPath",
    "artifactSha256",
    "counts",
    "leaseHeadSha",
    "outcome",
    "sourceReportEventIds",
    "synthesisId",
    "workerIds",
  ];
  if (Object.keys(record).sort().join(",") !== expectedKeys.sort().join(",")) {
    throw new TaskStateError("Scout synthesis record fields are invalid");
  }
  requireNonEmpty("synthesisId", record.synthesisId);
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(record.synthesisId)) {
    throw new TaskStateError("Scout synthesis ID is invalid");
  }
  if (!Array.isArray(record.workerIds) || record.workerIds.length !== 2 ||
    new Set(record.workerIds).size !== 2) {
    throw new TaskStateError("Scout synthesis requires exactly two unique workers");
  }
  if (!Array.isArray(record.sourceReportEventIds) ||
    record.sourceReportEventIds.length !== 2 ||
    new Set(record.sourceReportEventIds).size !== 2) {
    throw new TaskStateError("Scout synthesis requires two unique report events");
  }
  requireNonEmpty("synthesis lease SHA", record.leaseHeadSha);
  requireSha256("synthesis artifact digest", record.artifactSha256);
  const expectedPath = `tasks/${snapshot.id}/syntheses/${record.synthesisId}.json`;
  if (record.artifactPath !== expectedPath) {
    throw new TaskStateError("Scout synthesis artifact path is invalid");
  }
  if (!new Set(["aligned", "review_required"]).has(record.outcome)) {
    throw new TaskStateError("Scout synthesis outcome is invalid");
  }
  const countKeys = ["agreements", "disagreements", "followUpChecks", "unsupportedClaims"];
  if (!record.counts || typeof record.counts !== "object" ||
    Array.isArray(record.counts) ||
    Object.keys(record.counts).sort().join(",") !== countKeys.sort().join(",") ||
    countKeys.some((key) => !Number.isSafeInteger(record.counts[key]) ||
      record.counts[key] < 0)) {
    throw new TaskStateError("Scout synthesis counts are invalid");
  }
  const authorityHead = snapshot.worktree?.headSha;
  if (!authorityHead || authorityHead !== record.leaseHeadSha) {
    throw new TaskStateError("Scout synthesis does not match task authority");
  }
  for (const [index, workerId] of record.workerIds.entries()) {
    requireNonEmpty("synthesis worker ID", workerId);
    const worker = snapshot.workers.find(({ id }) => id === workerId);
    if (!worker || worker.status !== "reported" || worker.mode !== "scout" ||
      worker.sandbox !== "read-only" || worker.verification?.noMutation !== true ||
      worker.verification?.dirty !== false ||
      worker.verification?.headSha !== record.leaseHeadSha ||
      worker.reportEventId !== record.sourceReportEventIds[index] ||
      worker.report?.taskId !== snapshot.id) {
      throw new TaskStateError(
        `Scout synthesis worker lacks matching verified evidence: ${workerId}`,
      );
    }
  }
  const [first, second] = record.workerIds.map((workerId) =>
    snapshot.workers.find(({ id }) => id === workerId));
  if (first.worktreePath !== second.worktreePath ||
    first.worktreePath !== snapshot.worktree.worktreePath) {
    throw new TaskStateError("Scout synthesis workers have different worktree authority");
  }
}

function validateScoutFollowUpSelection(snapshot, selection) {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    throw new TaskStateError("Scout follow-up selection must be an object");
  }
  const expectedKeys = [
    "action", "checkIndex", "checkSha256", "followUpId", "leaseHeadSha",
    "promptSha256", "replyId", "selectorType", "synthesisArtifactSha256",
    "synthesisEventId", "synthesisId", "workerId",
  ];
  if (Object.keys(selection).sort().join(",") !== expectedKeys.sort().join(",")) {
    throw new TaskStateError("Scout follow-up selection fields are invalid");
  }
  for (const field of [
    "followUpId", "synthesisId", "synthesisEventId", "leaseHeadSha", "action",
    "workerId", "replyId",
  ]) requireNonEmpty(`follow-up ${field}`, selection[field]);
  requireIdentifier("followUpId", selection.followUpId);
  requireIdentifier("replyId", selection.replyId);
  requireSha256("follow-up synthesis digest", selection.synthesisArtifactSha256);
  requireSha256("follow-up check digest", selection.checkSha256);
  requireSha256("follow-up prompt digest", selection.promptSha256);
  if (selection.selectorType !== "human") {
    throw new TaskStateError("Scout follow-up selection requires a human selector");
  }
  const synthesis = snapshot.scoutSyntheses.find(({ synthesisId }) =>
    synthesisId === selection.synthesisId);
  if (!synthesis || synthesis.eventId !== selection.synthesisEventId ||
    synthesis.artifactSha256 !== selection.synthesisArtifactSha256 ||
    synthesis.leaseHeadSha !== selection.leaseHeadSha ||
    !synthesis.workerIds.includes(selection.workerId)) {
    throw new TaskStateError("Scout follow-up does not match its synthesis authority");
  }
  if (!Number.isSafeInteger(selection.checkIndex) || selection.checkIndex < 0 ||
    selection.checkIndex >= synthesis.counts.followUpChecks) {
    throw new TaskStateError("Scout follow-up check index is invalid");
  }
  if (snapshot.state !== "running" || snapshot.worktree?.status !== "leased" ||
    snapshot.worktree.headSha !== selection.leaseHeadSha) {
    throw new TaskStateError(
      "Scout follow-up requires a running task with its matching active lease",
    );
  }
  const worker = snapshot.workers.find(({ id }) => id === selection.workerId);
  if (!worker || worker.status !== "reported" || worker.mode !== "scout" ||
    worker.sandbox !== "read-only" || worker.verification?.noMutation !== true ||
    worker.verification?.dirty !== false ||
    worker.verification?.headSha !== selection.leaseHeadSha ||
    worker.replies?.some(({ id }) => id === selection.replyId)) {
    throw new TaskStateError("Scout follow-up worker lacks matching read-only authority");
  }
}

function validateScoutFollowUpResolution(snapshot, followUp, resolution) {
  const expectedKeys = [
    "counts", "followUpId", "leaseHeadSha", "outcome", "replyEventId",
    "replyId", "reportSha256", "selectionEventId", "workerId",
  ];
  if (!resolution || typeof resolution !== "object" || Array.isArray(resolution) ||
    Object.keys(resolution).sort().join(",") !== expectedKeys.sort().join(",")) {
    throw new TaskStateError("Scout follow-up resolution fields are invalid");
  }
  if (resolution.selectionEventId !== followUp.selectionEventId ||
    resolution.workerId !== followUp.workerId ||
    resolution.replyId !== followUp.replyId ||
    resolution.leaseHeadSha !== followUp.leaseHeadSha) {
    throw new TaskStateError("Scout follow-up resolution changed its selection binding");
  }
  requireNonEmpty("follow-up reply event", resolution.replyEventId);
  requireSha256("follow-up report digest", resolution.reportSha256);
  const worker = snapshot.workers.find(({ id }) => id === followUp.workerId);
  const reply = worker?.replies?.find(({ id }) => id === followUp.replyId);
  if (!reply || reply.status !== "completed" ||
    reply.completedEventId !== resolution.replyEventId ||
    reply.promptSha256 !== followUp.promptSha256 ||
    reply.leaseHeadSha !== followUp.leaseHeadSha ||
    reply.verification?.noMutation !== true || reply.verification?.dirty !== false ||
    reply.verification?.headSha !== followUp.leaseHeadSha ||
    resolution.reportSha256 !== digestText(stableStringify(reply.report)) ||
    resolution.outcome !== reply.report.status) {
    throw new TaskStateError("Scout follow-up resolution lacks its verified reply evidence");
  }
  const countKeys = ["files", "risks", "tests"];
  if (!resolution.counts || typeof resolution.counts !== "object" ||
    Array.isArray(resolution.counts) ||
    Object.keys(resolution.counts).sort().join(",") !== countKeys.join(",") ||
    countKeys.some((key) => !Number.isSafeInteger(resolution.counts[key]) ||
      resolution.counts[key] < 0) ||
    resolution.counts.files !== reply.report.files.length ||
    resolution.counts.tests !== reply.report.tests.length ||
    resolution.counts.risks !== reply.report.risks.length) {
    throw new TaskStateError("Scout follow-up resolution counts are invalid");
  }
}

function validateEventEnvelope(event, index) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TaskStateError(`Event ${index + 1} must be an object`);
  }
  for (const field of ["id", "taskId", "type", "at", "actor"]) {
    requireNonEmpty(field, event[field]);
  }
  validateTaskId(event.taskId);
  if (Number.isNaN(Date.parse(event.at))) {
    throw new TaskStateError(`Event ${event.id} has an invalid timestamp`);
  }
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
    throw new TaskStateError(`Event ${event.id} data must be an object`);
  }
}

function requireCreated(snapshot, event) {
  if (snapshot.id === null) {
    throw new TaskStateError(`${event.type} cannot occur before task.created`);
  }
}

function requireWorktreeStatus(snapshot, event, expected) {
  requireCreated(snapshot, event);
  if (snapshot.worktree?.status !== expected) {
    throw new TaskStateError(
      `${event.type} requires worktree status ${expected}, found ${snapshot.worktree?.status || "none"}`,
    );
  }
}

function requireMatchingWorktree(snapshot, worktreePath, headSha) {
  if (
    worktreePath !== snapshot.worktree.worktreePath ||
    headSha !== snapshot.worktree.headSha
  ) {
    throw new TaskStateError("Worktree proof does not match the active lease");
  }
}

function findWorker(snapshot, workerId) {
  requireNonEmpty("workerId", workerId);
  const worker = snapshot.workers.find((candidate) => candidate.id === workerId);
  if (!worker) {
    throw new TaskStateError(`Unknown worker: ${workerId}`);
  }
  return worker;
}

function findWorkerReply(worker, replyId) {
  requireNonEmpty("replyId", replyId);
  const reply = (worker.replies || []).find((candidate) => candidate.id === replyId);
  if (!reply) throw new TaskStateError(`Unknown worker reply: ${replyId}`);
  return reply;
}

function requireWorkerStatus(snapshot, event, expected) {
  requireCreated(snapshot, event);
  const worker = findWorker(snapshot, event.data.workerId);
  if (worker.status !== expected) {
    throw new TaskStateError(
      `${event.type} requires worker status ${expected}, found ${worker.status}`,
    );
  }
  return worker;
}

function requireNonEmpty(label, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TaskStateError(`${label} must be a non-empty string`);
  }
}

function requireIdentifier(label, value) {
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(value)) {
    throw new TaskStateError(`${label} must be a safe 3-64 character identifier`);
  }
}

function validateDraftPrBinding(snapshot, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskStateError("Draft PR binding must be an object");
  }
  requireNonEmpty("draft PR repository", value.repository);
  requireNonEmpty("draft PR head branch", value.headBranch);
  requireNonEmpty("draft PR base branch", value.baseBranch);
  requireFullSha("draft PR head SHA", value.headSha);
  requireSha256("draft PR title digest", value.titleSha256);
  requireSha256("draft PR body digest", value.bodySha256);
  if (value.repository.toLowerCase() !== snapshot.repo.toLowerCase()) {
    throw new TaskStateError("Draft PR repository does not match the task");
  }
  if (value.headSha !== snapshot.worktree?.headSha) {
    throw new TaskStateError("Draft PR head SHA does not match the active lease");
  }
}

function requirePassingActiveValidation(snapshot) {
  const validation = snapshot.validationRuns.at(-1);
  if (
    snapshot.state !== "validating" ||
    snapshot.worktree?.status !== "leased" ||
    validation?.passed !== true ||
    validation.finalHeadSha !== snapshot.worktree.headSha
  ) {
    throw new TaskStateError(
      "Draft PR creation requires passing validation for the active leased head",
    );
  }
}

function sameDraftPrBinding(left, right) {
  return [
    "repository", "headBranch", "headSha", "baseBranch", "titleSha256",
    "bodySha256",
  ].every((field) => left[field] === right[field]);
}

function requireDraftPrOperation(snapshot, operationId, status) {
  requireNonEmpty("draft PR operation ID", operationId);
  const operation = snapshot.githubDraftPullRequests.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!operation) throw new TaskStateError(`Unknown draft PR operation: ${operationId}`);
  if (operation.status !== status) {
    throw new TaskStateError(
      `Draft PR operation ${operationId} requires status ${status}, found ${operation.status}`,
    );
  }
  return operation;
}

function validateCreatedDraftPullRequest(snapshot, operation, pullRequest) {
  if (!pullRequest || typeof pullRequest !== "object" || Array.isArray(pullRequest)) {
    throw new TaskStateError("Created draft PR observation must be an object");
  }
  requireObservation(pullRequest, "created draft pull request");
  requireNonEmpty("created draft PR title", pullRequest.title);
  if (
    pullRequest.repository?.toLowerCase() !== snapshot.repo.toLowerCase() ||
    pullRequest.state !== "open" ||
    pullRequest.draft !== true ||
    pullRequest.head?.repository?.toLowerCase() !== snapshot.repo.toLowerCase() ||
    pullRequest.head?.branch !== operation.headBranch ||
    pullRequest.head?.sha !== operation.headSha ||
    pullRequest.base?.branch !== operation.baseBranch ||
    digestText(pullRequest.title) !== operation.titleSha256
  ) {
    throw new TaskStateError("Created draft PR does not match its approved exact target");
  }
}

function digestText(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) =>
      [key, sortValue(value[key])]));
  }
  return value;
}

function requireSha256(label, value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TaskStateError(`${label} must be a SHA-256 digest`);
  }
}

function requireFirstmateRun(snapshot, requestId, expectedStatus) {
  requireNonEmpty("Firstmate request ID", requestId);
  const run = snapshot.firstmateRuns.find(
    (candidate) => candidate.requestId === requestId,
  );
  if (!run) {
    throw new TaskStateError(`Unknown Firstmate request: ${requestId}`);
  }
  if (run.status !== expectedStatus) {
    throw new TaskStateError(
      `Firstmate request ${requestId} requires status ${expectedStatus}, found ${run.status}`,
    );
  }
  return run;
}

function validateFirstmateClassification(snapshot, classification) {
  if (!classification || typeof classification !== "object" || Array.isArray(classification)) {
    throw new TaskStateError("Firstmate classification must be an object");
  }
  const expectedFields = [
    "schemaVersion",
    "summary",
    "taskType",
    "requiredAuthority",
    "approvalBoundary",
    "recommendedNextStep",
    "requiresHumanApproval",
  ];
  if (
    Object.keys(classification).sort().join(",") !==
    [...expectedFields].sort().join(",")
  ) {
    throw new TaskStateError("Firstmate classification fields are not exact");
  }
  if (classification.schemaVersion !== 1) {
    throw new TaskStateError("Firstmate classification schemaVersion must be 1");
  }
  requireNonEmpty("Firstmate summary", classification.summary);
  requireNonEmpty("Firstmate recommended next step", classification.recommendedNextStep);
  const taskTypes = new Set([
    "answer",
    "review",
    "diagnosis",
    "code_change",
    "external_operation",
  ]);
  const authorities = new Set([
    "read_only",
    "local_write",
    "external_write",
    "destructive",
  ]);
  const boundaries = new Set([
    "none",
    "before_external_write",
    "before_destructive_action",
  ]);
  if (!taskTypes.has(classification.taskType)) {
    throw new TaskStateError(`Invalid Firstmate task type: ${classification.taskType}`);
  }
  if (!authorities.has(classification.requiredAuthority)) {
    throw new TaskStateError(
      `Invalid Firstmate authority: ${classification.requiredAuthority}`,
    );
  }
  if (!boundaries.has(classification.approvalBoundary)) {
    throw new TaskStateError(
      `Invalid Firstmate approval boundary: ${classification.approvalBoundary}`,
    );
  }
  const expectedBoundary = {
    read_only: "none",
    local_write: "none",
    external_write: "before_external_write",
    destructive: "before_destructive_action",
  }[classification.requiredAuthority];
  const expectedApproval = expectedBoundary !== "none";
  if (
    classification.approvalBoundary !== expectedBoundary ||
    classification.requiresHumanApproval !== expectedApproval
  ) {
    throw new TaskStateError(
      "Firstmate approval boundary is inconsistent with required authority",
    );
  }
  if (snapshot.kind !== "firstmate-intake") {
    throw new TaskStateError("Firstmate classification requires an intake task");
  }
}

function validateFirstmateUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw new TaskStateError("Firstmate usage must be an object");
  }
  const fields = ["requests", "inputTokens", "outputTokens", "totalTokens"];
  if (Object.keys(usage).sort().join(",") !== [...fields].sort().join(",")) {
    throw new TaskStateError("Firstmate usage fields are not exact");
  }
  for (const field of fields) {
    if (!Number.isSafeInteger(usage[field]) || usage[field] < 0) {
      throw new TaskStateError(`Firstmate usage ${field} must be non-negative`);
    }
  }
  if (usage.totalTokens < usage.inputTokens + usage.outputTokens) {
    throw new TaskStateError("Firstmate total token usage is inconsistent");
  }
}

function validateGitHubStatusReport(snapshot, report, event) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new TaskStateError("GitHub status report must be an object");
  }
  if (report.schemaVersion !== 1) {
    throw new TaskStateError("GitHub status report schemaVersion must be 1");
  }
  requireNonEmpty("GitHub status actor", report.actor);
  requireTimestamp("GitHub status observedAt", report.observedAt);
  if (report.actor !== event.actor || Date.parse(report.observedAt) !== Date.parse(event.at)) {
    throw new TaskStateError("GitHub status actor and timestamp must match the event envelope");
  }
  const repository = report.repository;
  requireObservation(repository, "repository");
  if (repository.nameWithOwner?.toLowerCase() !== snapshot.repo.toLowerCase()) {
    throw new TaskStateError("GitHub status repository does not match the task");
  }
  const pullRequest = report.pullRequest;
  requireObservation(pullRequest, "pullRequest");
  if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number < 1) {
    throw new TaskStateError("GitHub status pull request number must be positive");
  }
  if (pullRequest.repository?.toLowerCase() !== snapshot.repo.toLowerCase()) {
    throw new TaskStateError("GitHub pull request repository does not match the task");
  }
  requireFullSha("GitHub pull request head SHA", pullRequest.head?.sha);
  requireFullSha("GitHub pull request base SHA", pullRequest.base?.sha);
  requireObservation(report.branchProtection, "branchProtection");
  for (const [label, observations] of Object.entries({
    checks: report.checks,
    reviews: report.reviews,
    workflowRuns: report.workflowRuns,
  })) {
    if (!Array.isArray(observations)) {
      throw new TaskStateError(`GitHub status ${label} must be an array`);
    }
    for (const observation of observations) requireObservation(observation, label);
  }
  if (
    report.checks.some((check) => check.headSha !== pullRequest.head.sha) ||
    report.workflowRuns.some((run) => run.headSha !== pullRequest.head.sha)
  ) {
    throw new TaskStateError("GitHub check or workflow evidence does not match the PR head SHA");
  }
  const required = report.requiredChecks;
  if (
    !required ||
    !Array.isArray(required.names) ||
    !Array.isArray(required.missing) ||
    !Array.isArray(required.unsuccessful) ||
    typeof required.satisfied !== "boolean"
  ) {
    throw new TaskStateError("GitHub required-check summary is malformed");
  }
  for (const [label, names] of Object.entries({
    names: required.names,
    missing: required.missing,
    unsuccessful: required.unsuccessful,
  })) {
    if (names.some((name) => typeof name !== "string" || name.trim() === "")) {
      throw new TaskStateError(`GitHub required-check ${label} must contain names`);
    }
    if (new Set(names).size !== names.length) {
      throw new TaskStateError(`GitHub required-check ${label} contains duplicates`);
    }
  }
  const checksByName = new Map();
  for (const check of report.checks) {
    requireNonEmpty("GitHub check name", check.name);
    if (checksByName.has(check.name)) {
      throw new TaskStateError(`GitHub check name is ambiguous: ${check.name}`);
    }
    checksByName.set(check.name, check);
  }
  const expectedMissing = required.names.filter((name) => !checksByName.has(name));
  const expectedUnsuccessful = required.names.filter((name) => {
    const check = checksByName.get(name);
    return check && (check.status !== "completed" || check.conclusion !== "success");
  });
  if (
    !sameArray(required.missing, expectedMissing) ||
    !sameArray(required.unsuccessful, expectedUnsuccessful)
  ) {
    throw new TaskStateError("GitHub required-check summary does not match check evidence");
  }
  const expectedSatisfied = expectedMissing.length === 0 && expectedUnsuccessful.length === 0;
  if (required.satisfied !== expectedSatisfied) {
    throw new TaskStateError("GitHub required-check summary is inconsistent");
  }
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireObservation(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskStateError(`GitHub ${label} observation must be an object`);
  }
  requireTimestamp(`GitHub ${label} observedAt`, value.observedAt);
  if (value.source?.kind !== "github-rest") {
    throw new TaskStateError(`GitHub ${label} observation source must be github-rest`);
  }
  requireNonEmpty(`GitHub ${label} source endpoint`, value.source.endpoint);
}

function requireTimestamp(label, value) {
  requireNonEmpty(label, value);
  if (Number.isNaN(Date.parse(value))) {
    throw new TaskStateError(`${label} must be a timestamp`);
  }
}

function requireFullSha(label, value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/iu.test(value)) {
    throw new TaskStateError(`${label} must be a full SHA`);
  }
}

function validateLocalValidationReport(snapshot, report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new TaskStateError("Local validation report must be an object");
  }
  if (
    report.schemaVersion !== 1 ||
    report.taskId !== snapshot.id ||
    report.mode !== "local-only" ||
    report.remoteOperations !== false
  ) {
    throw new TaskStateError("Local validation report identity or mode is invalid");
  }
  if (typeof report.passed !== "boolean" || typeof report.headChanged !== "boolean") {
    throw new TaskStateError("Local validation result flags must be boolean");
  }
  requireTimestamp("Local validation startedAt", report.startedAt);
  requireTimestamp("Local validation completedAt", report.completedAt);
  requireFullSha("Local validation initial head", report.initialHeadSha);
  requireFullSha("Local validation final head", report.finalHeadSha);
  requireNonEmpty("Local validation branch", report.branch);
  requireNonEmpty("Local validation run ID", report.runId);
  requireNonEmpty("Local validation run status", report.runStatus);
  const expectedSteps = [
    "intent",
    "rebase",
    "review",
    "test",
    "document",
    "lint",
    "push",
    "pr",
    "ci",
  ];
  const remoteSteps = new Set(["rebase", "push", "pr", "ci"]);
  if (
    !Array.isArray(report.steps) ||
    report.steps.map(({ step }) => step).join(",") !== expectedSteps.join(",")
  ) {
    throw new TaskStateError("Local validation steps are incomplete or out of order");
  }
  for (const step of report.steps) {
    requireNonEmpty("Local validation step status", step.status);
    const remoteAllowed = report.gate === null
      ? new Set(["skipped"])
      : new Set(["pending", "skipped"]);
    if (remoteSteps.has(step.step) && !remoteAllowed.has(step.status)) {
      throw new TaskStateError(`Local validation remote step ${step.step} was not skipped`);
    }
  }
  if (
    report.command?.skipSteps?.join(",") !== "rebase,push,pr,ci" ||
    !Array.isArray(report.command?.args) ||
    report.command.args.includes("--yes")
  ) {
    throw new TaskStateError("Local validation command is not capability-limited");
  }
  if (
    !report.process ||
    !Number.isInteger(report.process.exitCode) ||
    !/^[a-f0-9]{64}$/u.test(report.process.stdoutSha256) ||
    !/^[a-f0-9]{64}$/u.test(report.process.stderrSha256)
  ) {
    throw new TaskStateError("Local validation process evidence is malformed");
  }
  if (
    report.passed === true &&
    (report.outcome !== "passed" ||
      report.process.exitCode !== 0 ||
      report.gate !== null ||
      report.headChanged !== false ||
      report.initialHeadSha !== report.finalHeadSha)
  ) {
    throw new TaskStateError("Passing local validation evidence is inconsistent");
  }
}

function validateRecoveryAudit(snapshot, report, event) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new TaskStateError("Recovery audit report must be an object");
  }
  if (
    report.schemaVersion !== 1 ||
    report.taskId !== snapshot.id ||
    report.actor !== event.actor ||
    report.auditedEventId !== snapshot.lastEventId ||
    report.auditedEventsCount !== snapshot.eventsCount
  ) {
    throw new TaskStateError("Recovery audit identity or ledger watermark is invalid");
  }
  requireNonEmpty("Recovery audit ID", report.auditId);
  requireTimestamp("Recovery audit observedAt", report.observedAt);
  if (Date.parse(report.observedAt) !== Date.parse(event.at)) {
    throw new TaskStateError("Recovery audit timestamp must match its event");
  }
  if (!Array.isArray(report.checks) || report.checks.length === 0) {
    throw new TaskStateError("Recovery audit must contain checks");
  }
  const validStatuses = new Set(["pass", "not_applicable", "recovery_required"]);
  for (const item of report.checks) {
    requireNonEmpty("Recovery check kind", item.kind);
    requireNonEmpty("Recovery check detail", item.detail);
    if (!validStatuses.has(item.status)) {
      throw new TaskStateError(`Invalid recovery check status: ${item.status}`);
    }
    if (item.status === "recovery_required") {
      requireNonEmpty("Recovery check action", item.action);
    }
  }
  const expectedSafe = !report.checks.some(({ status }) => status === "recovery_required");
  if (report.safeToResume !== expectedSafe) {
    throw new TaskStateError("Recovery audit safeToResume is inconsistent");
  }
  if (!Array.isArray(report.recommendedActions)) {
    throw new TaskStateError("Recovery audit recommendedActions must be an array");
  }
  const expectedActions = [
    ...new Set(
      report.checks
        .filter(({ status }) => status === "recovery_required")
        .map(({ action }) => action),
    ),
  ];
  if (!sameArray(report.recommendedActions, expectedActions)) {
    throw new TaskStateError("Recovery audit actions do not match its checks");
  }
}
