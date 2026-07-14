import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  replayTaskEvents,
  TaskStateError,
  validateTaskId,
} from "../core/task-state.js";

export class TaskStore {
  constructor({
    rootDir = path.resolve(".shipmates"),
    clock = () => new Date(),
    idFactory = randomUUID,
    lockTimeoutMs = 2_000,
    lockRetryMs = 20,
  } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.clock = clock;
    this.idFactory = idFactory;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockRetryMs = lockRetryMs;
  }

  async createTask({ taskId, kind, repo, baseSha, actor, eventId, at }) {
    return this.#append(
      taskId,
      {
        id: eventId || this.idFactory(),
        taskId,
        type: "task.created",
        at,
        actor,
        data: { kind, repo, baseSha },
      },
      { requireAbsent: true },
    );
  }

  async transition({ taskId, from, to, actor, reason, eventId, at }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "task.transitioned",
      at,
      actor,
      data: { from, to, ...(reason ? { reason } : {}) },
    });
  }

  async recordEvidence({ taskId, actor, kind, value, eventId, at }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "task.evidence.recorded",
      at,
      actor,
      data: { kind, value },
    });
  }

  async recordApproval({
    taskId,
    actor,
    repo,
    prNumber,
    headSha,
    mergeMethod,
    decision,
    eventId,
    at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "task.approval.recorded",
      at,
      actor,
      data: { repo, prNumber, headSha, mergeMethod, decision },
    });
  }

  async recordGitHubStatus({ taskId, actor, report, eventId, at }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "github.status.recorded",
      at,
      actor,
      data: { report },
    });
  }

  async recordGitHubMergeApproval({ taskId, actor, approval, eventId, at }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "github.merge.approved",
      at,
      actor,
      data: approval,
    });
  }

  async requestGitHubMerge({ taskId, actor, request, eventId, at }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "github.merge.requested",
      at,
      actor,
      data: request,
    });
  }

  async recordGitHubMergeCompleted({
    taskId, actor, operationId, requestEventId, result, eventId, at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "github.merge.completed",
      at,
      actor,
      data: { operationId, requestEventId, result },
    });
  }

  async recordGitHubMergeFailure({
    taskId, actor, operationId, requestEventId, code, eventId, at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "github.merge.failed",
      at,
      actor,
      data: { operationId, requestEventId, code },
    });
  }

  async recordPostMergeAssurance({ taskId, actor, report, eventId, at }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "github.post_merge.verified",
      at,
      actor,
      data: { report },
    });
  }

  async recordDraftPullRequestApproval({ taskId, actor, approval, eventId, at }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "github.draft_pr.approved",
      at,
      actor,
      data: approval,
    });
  }

  async requestDraftPullRequestCreate({ taskId, actor, request, eventId, at }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "github.draft_pr.create.requested",
      at,
      actor,
      data: request,
    });
  }

  async recordDraftPullRequestCreated({
    taskId, actor, operationId, requestEventId, pullRequest, eventId, at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "github.draft_pr.create.completed",
      at,
      actor,
      data: { operationId, requestEventId, pullRequest },
    });
  }

  async recordDraftPullRequestFailure({
    taskId, actor, operationId, requestEventId, message, eventId, at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "github.draft_pr.create.failed",
      at,
      actor,
      data: { operationId, requestEventId, message },
    });
  }

  async recordGitPushApproval({ taskId, actor, approval, eventId, at }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "git.push.approved",
      at,
      actor,
      data: approval,
    });
  }

  async requestGitPush({ taskId, actor, request, eventId, at }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "git.push.requested",
      at,
      actor,
      data: request,
    });
  }

  async recordGitPushCompleted({
    taskId, actor, operationId, requestEventId, result, eventId, at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "git.push.completed",
      at,
      actor,
      data: { operationId, requestEventId, result },
    });
  }

  async recordGitPushFailure({
    taskId, actor, operationId, requestEventId, code, eventId, at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "git.push.failed",
      at,
      actor,
      data: { operationId, requestEventId, code },
    });
  }

  async recordBranchCleanupApproval({ taskId, actor, approval, eventId, at }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "git.branch_cleanup.approved",
      at,
      actor,
      data: approval,
    });
  }

  async requestBranchCleanup({ taskId, actor, request, eventId, at }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "git.branch_cleanup.requested",
      at,
      actor,
      data: request,
    });
  }

  async recordBranchCleanupCompleted({
    taskId, actor, operationId, requestEventId, result, eventId, at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "git.branch_cleanup.completed",
      at,
      actor,
      data: { operationId, requestEventId, result },
    });
  }

  async recordBranchCleanupFailure({
    taskId, actor, operationId, requestEventId, code, eventId, at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "git.branch_cleanup.failed",
      at,
      actor,
      data: { operationId, requestEventId, code },
    });
  }

  async requestGitCommit({ taskId, actor, request, eventId, at }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "git.commit.requested",
      at,
      actor,
      data: request,
    });
  }

  async recordGitCommitCompleted({
    taskId, actor, operationId, requestEventId, result, eventId, at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "git.commit.completed",
      at,
      actor,
      data: { operationId, requestEventId, result },
    });
  }

  async requestLocalValidation({ taskId, actor, request, eventId, at }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "validation.local.requested",
      at,
      actor,
      data: request,
    });
  }

  async recordLocalValidation({
    taskId, actor, report, operationId, requestEventId, eventId, at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "validation.local.recorded",
      at,
      actor,
      data: {
        report,
        ...(operationId ? { operationId, requestEventId } : {}),
      },
    });
  }

  async recordRecoveryAudit({ taskId, actor, report, eventId, at }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "recovery.audit.recorded",
      at,
      actor,
      data: { report },
    });
  }

  async requestFirstmateRun({
    taskId,
    actor,
    requestId,
    attemptId,
    requestSha256,
    model,
    maxTurns,
    tracingEnabled,
    storeResponse,
    eventId,
    at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "firstmate.run.requested",
      at,
      actor,
      data: {
        requestId,
        attemptId,
        requestSha256,
        model,
        maxTurns,
        tracingEnabled,
        storeResponse,
      },
    });
  }

  async recordFirstmateClassification({
    taskId,
    actor,
    requestId,
    requestEventId,
    classification,
    usage,
    eventId,
    at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "firstmate.run.classified",
      at,
      actor,
      data: { requestId, requestEventId, classification, usage },
    });
  }

  async recordFirstmateFailure({
    taskId,
    actor,
    requestId,
    requestEventId,
    category,
    message,
    eventId,
    at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "firstmate.run.failed",
      at,
      actor,
      data: { requestId, requestEventId, category, message },
    });
  }

  async requestWorktreeLease({
    taskId,
    actor,
    repoPath,
    baseSha,
    eventId,
    at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "worktree.lease.requested",
      at,
      actor,
      data: { repoPath, baseSha },
    });
  }

  async recordWorktreeLease({
    taskId,
    actor,
    requestEventId,
    repoPath,
    worktreePath,
    headSha,
    branch,
    eventId,
    at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "worktree.leased",
      at,
      actor,
      data: {
        requestEventId,
        repoPath,
        worktreePath,
        headSha,
        branch,
      },
    });
  }

  async recordWorktreeProof({ taskId, actor, proof, eventId, at }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "worktree.proof.recorded",
      at,
      actor,
      data: { ...proof },
    });
  }

  async requestWorktreeReturn({
    taskId,
    actor,
    worktreePath,
    proofEventId,
    eventId,
    at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "worktree.return.requested",
      at,
      actor,
      data: { worktreePath, proofEventId },
    });
  }

  async recordWorktreeReturn({
    taskId,
    actor,
    worktreePath,
    requestEventId,
    eventId,
    at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "worktree.returned",
      at,
      actor,
      data: { worktreePath, requestEventId },
    });
  }

  async requestWorkerDispatch({
    taskId,
    actor,
    workerId,
    backend,
    mode,
    worktreePath,
    sandbox,
    brief,
    briefSha256,
    paneId = null,
    eventId,
    at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "worker.dispatch.requested",
      at,
      actor,
      data: {
        workerId,
        backend,
        mode,
        worktreePath,
        sandbox,
        brief,
        briefSha256,
        ...(paneId ? { paneId } : {}),
      },
    });
  }

  async recordWorkerStarted({
    taskId,
    actor,
    workerId,
    requestEventId,
    threadId,
    eventId,
    at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "worker.started",
      at,
      actor,
      data: { workerId, requestEventId, threadId },
    });
  }

  async recordWorkerReport({
    taskId,
    actor,
    workerId,
    threadId,
    report,
    verification,
    eventId,
    at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "worker.report.recorded",
      at,
      actor,
      data: { workerId, threadId, report, verification },
    });
  }

  async recordWorkerFailure({
    taskId,
    actor,
    workerId,
    message,
    eventId,
    at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "worker.failed",
      at,
      actor,
      data: { workerId, message },
    });
  }

  async recordScoutSynthesis({
    taskId,
    actor,
    synthesis,
    eventId,
    at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "scout.synthesis.recorded",
      at,
      actor,
      data: synthesis,
    });
  }

  async recordScoutFollowUpSelection({ taskId, actor, selection, eventId, at }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "scout.follow_up.selected",
      at,
      actor,
      data: selection,
    });
  }

  async recordScoutFollowUpResolution({ taskId, actor, resolution, eventId, at }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "scout.follow_up.resolved",
      at,
      actor,
      data: resolution,
    });
  }

  async requestWorkerReply({
    taskId, actor, workerId, replyId, threadId, leaseHeadSha, sandbox,
    promptSha256, eventId, at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "worker.reply.requested",
      at,
      actor,
      data: { workerId, replyId, threadId, leaseHeadSha, sandbox, promptSha256 },
    });
  }

  async recordWorkerReplyCompleted({
    taskId, actor, workerId, replyId, requestEventId, threadId, leaseHeadSha,
    report, verification, eventId, at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "worker.reply.completed",
      at,
      actor,
      data: {
        workerId, replyId, requestEventId, threadId, leaseHeadSha,
        report, verification,
      },
    });
  }

  async recordWorkerReplyFailed({
    taskId, actor, workerId, replyId, requestEventId, message, eventId, at,
  }) {
    return this.#append(taskId, {
      id: eventId || this.idFactory(),
      taskId,
      type: "worker.reply.failed",
      at,
      actor,
      data: { workerId, replyId, requestEventId, message },
    });
  }

  async getSnapshot(taskId) {
    validateTaskId(taskId);
    const events = await this.#readEvents(taskId);
    return replayTaskEvents(events);
  }

  async rebuildSnapshot(taskId) {
    validateTaskId(taskId);
    return this.#withLock(taskId, async () => {
      const snapshot = replayTaskEvents(await this.#readEvents(taskId));
      await this.#writeSnapshot(taskId, snapshot);
      return snapshot;
    });
  }

  async readEvents(taskId) {
    validateTaskId(taskId);
    return this.#readEvents(taskId);
  }

  async listTaskIds() {
    const tasksDirectory = path.join(this.rootDir, "tasks");
    let entries;
    try {
      entries = await readdir(tasksDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory() &&
        /^[a-z0-9][a-z0-9._-]{2,63}$/u.test(entry.name))
      .map(({ name }) => name)
      .sort();
  }

  async #append(taskId, event, { requireAbsent = false } = {}) {
    validateTaskId(taskId);
    return this.#withLock(taskId, async () => {
      const candidate = {
        ...event,
        at: event.at || this.clock().toISOString(),
      };
      const events = await this.#readEvents(taskId, { allowMissing: true });
      if (requireAbsent && events.length > 0) {
        const duplicate = findIdempotentEvent(events, candidate);
        if (duplicate) {
          return replayTaskEvents(events);
        }
        throw new TaskStoreError(`Task already exists: ${taskId}`);
      }

      const duplicate = findIdempotentEvent(events, candidate);
      if (duplicate) {
        const snapshot = replayTaskEvents(events);
        await this.#writeSnapshot(taskId, snapshot);
        return snapshot;
      }

      const nextEvents = [...events, candidate];
      const snapshot = replayTaskEvents(nextEvents);
      await this.#atomicWrite(
        this.#eventsPath(taskId),
        `${nextEvents.map((item) => JSON.stringify(item)).join("\n")}\n`,
      );
      await this.#writeSnapshot(taskId, snapshot);
      return snapshot;
    });
  }

  async #readEvents(taskId, { allowMissing = false } = {}) {
    let contents;
    try {
      contents = await readFile(this.#eventsPath(taskId), "utf8");
    } catch (error) {
      if (allowMissing && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const lines = contents.split(/\r?\n/u).filter((line) => line !== "");
    return lines.map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (cause) {
        throw new TaskStoreError(
          `Invalid JSON in ${this.#eventsPath(taskId)} at line ${index + 1}`,
          { cause },
        );
      }
    });
  }

  async #writeSnapshot(taskId, snapshot) {
    await this.#atomicWrite(
      this.#snapshotPath(taskId),
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
  }

  async #withLock(taskId, operation) {
    const taskDir = this.#taskDir(taskId);
    await mkdir(taskDir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(taskDir, "write.lock");
    const startedAt = Date.now();
    let handle;

    while (!handle) {
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new TaskStoreError(`Timed out waiting for task lock: ${taskId}`);
        }
        await delay(this.lockRetryMs);
      }
    }

    try {
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
      );
      await handle.sync();
      return await operation();
    } finally {
      await handle.close();
      await unlink(lockPath).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }
  }

  async #atomicWrite(targetPath, contents) {
    await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${targetPath}.tmp-${process.pid}-${this.idFactory()}`;
    let handle;

    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporaryPath, targetPath);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  #taskDir(taskId) {
    return path.join(this.rootDir, "tasks", validateTaskId(taskId));
  }

  #eventsPath(taskId) {
    return path.join(this.#taskDir(taskId), "events.jsonl");
  }

  #snapshotPath(taskId) {
    return path.join(this.#taskDir(taskId), "snapshot.json");
  }
}

export class TaskStoreError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "TaskStoreError";
  }
}

function findIdempotentEvent(events, candidate) {
  const existing = events.find((event) => event.id === candidate.id);
  if (!existing) {
    return null;
  }
  const comparable = ({ taskId, type, actor, data }) => ({
    taskId,
    type,
    actor,
    data,
  });
  if (
    JSON.stringify(comparable(existing)) !==
    JSON.stringify(comparable(candidate))
  ) {
    throw new TaskStateError(
      `Event id ${candidate.id} was reused with a different payload`,
    );
  }
  return existing;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
