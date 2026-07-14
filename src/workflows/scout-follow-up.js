import { createHash } from "node:crypto";

import {
  loadScoutSynthesisArtifact,
  stableStringify,
} from "./scout-synthesis.js";

export class ScoutFollowUpWorkflow {
  constructor({ store, scoutWorkflow, actor = "firstmate" } = {}) {
    if (!store || typeof store.getSnapshot !== "function" ||
      typeof store.recordScoutFollowUpSelection !== "function" ||
      typeof store.recordScoutFollowUpResolution !== "function" ||
      !scoutWorkflow || typeof scoutWorkflow.reply !== "function" ||
      typeof scoutWorkflow.reconcileReply !== "function") {
      throw new TypeError(
        "ScoutFollowUpWorkflow requires a writable store and scout workflow",
      );
    }
    this.store = store;
    this.scoutWorkflow = scoutWorkflow;
    this.actor = actor;
  }

  async run({
    taskId, synthesisId, followUpId, checkIndex, workerId, replyId, humanActor,
  }) {
    requireIdentifier("synthesisId", synthesisId);
    requireIdentifier("followUpId", followUpId);
    requireIdentifier("workerId", workerId);
    requireIdentifier("replyId", replyId);
    requireHumanActor(humanActor, this.actor);
    if (!Number.isSafeInteger(checkIndex) || checkIndex < 0) {
      throw new TypeError("checkIndex must be a non-negative integer");
    }

    let { snapshot, selection, prompt, reused } = await this.#select({
      taskId, synthesisId, followUpId, checkIndex, workerId, replyId, humanActor,
    });
    if (selection.status === "resolved") {
      return { snapshot, followUp: selection, reused: true };
    }
    snapshot = await this.scoutWorkflow.reply({
      taskId,
      workerId,
      replyId,
      prompt,
    });
    snapshot = await this.#resolve({ taskId, followUpId, snapshot });
    return {
      snapshot,
      followUp: findFollowUp(snapshot, followUpId),
      reused,
    };
  }

  async reconcile({ taskId, followUpId }) {
    requireIdentifier("followUpId", followUpId);
    let snapshot = await this.store.getSnapshot(taskId);
    const selection = findFollowUp(snapshot, followUpId);
    if (selection.status === "resolved") {
      return { snapshot, followUp: selection, reused: true };
    }
    snapshot = await this.scoutWorkflow.reconcileReply({
      taskId,
      workerId: selection.workerId,
      replyId: selection.replyId,
    });
    snapshot = await this.#resolve({ taskId, followUpId, snapshot });
    return {
      snapshot,
      followUp: findFollowUp(snapshot, followUpId),
      reused: false,
    };
  }

  async #select({
    taskId, synthesisId, followUpId, checkIndex, workerId, replyId, humanActor,
  }) {
    let snapshot = await this.store.getSnapshot(taskId);
    const synthesis = (snapshot.scoutSyntheses || []).find(
      (candidate) => candidate.synthesisId === synthesisId,
    );
    if (!synthesis) {
      throw new ScoutFollowUpError(`Unknown scout synthesis: ${synthesisId}`);
    }
    if (!synthesis.workerIds.includes(workerId)) {
      throw new ScoutFollowUpAuthorityError(
        `Worker ${workerId} is not a source for synthesis ${synthesisId}`,
      );
    }
    const artifact = await loadScoutSynthesisArtifact({
      store: this.store,
      snapshot,
      record: synthesis,
    });
    const check = artifact.followUpChecks[checkIndex];
    if (!check) {
      throw new ScoutFollowUpError(
        `Synthesis ${synthesisId} has no follow-up check at index ${checkIndex}`,
      );
    }
    const prompt = buildFollowUpPrompt({
      taskId,
      synthesisId,
      followUpId,
      check,
    });
    const binding = {
      followUpId,
      synthesisId,
      synthesisEventId: synthesis.eventId,
      synthesisArtifactSha256: synthesis.artifactSha256,
      leaseHeadSha: synthesis.leaseHeadSha,
      checkIndex,
      checkSha256: digest(stableStringify(check)),
      action: check.action,
      workerId,
      replyId,
      promptSha256: digest(prompt),
      selectorType: "human",
    };
    const existing = (snapshot.scoutFollowUps || []).find(
      (candidate) => candidate.followUpId === followUpId,
    );
    if (existing) {
      verifyExistingSelection(existing, binding);
      return { snapshot, selection: existing, prompt, reused: true };
    }
    if (snapshot.state !== "running" || snapshot.worktree?.status !== "leased" ||
      snapshot.worktree.headSha !== synthesis.leaseHeadSha) {
      throw new ScoutFollowUpAuthorityError(
        "Follow-up selection requires the matching active read-only lease",
      );
    }
    snapshot = await this.store.recordScoutFollowUpSelection({
      taskId,
      actor: humanActor,
      selection: binding,
      eventId: `${taskId}:scout-follow-up:${followUpId}:selected:v1`,
    });
    return {
      snapshot,
      selection: findFollowUp(snapshot, followUpId),
      prompt,
      reused: false,
    };
  }

  async #resolve({ taskId, followUpId, snapshot }) {
    const selection = findFollowUp(snapshot, followUpId);
    if (selection.status === "resolved") return snapshot;
    const worker = snapshot.workers.find(({ id }) => id === selection.workerId);
    const reply = worker?.replies?.find(({ id }) => id === selection.replyId);
    if (reply?.status !== "completed") {
      throw new ScoutFollowUpRecoveryRequiredError(
        `Follow-up ${followUpId} has no verified completed reply`,
      );
    }
    return this.store.recordScoutFollowUpResolution({
      taskId,
      actor: this.actor,
      resolution: {
        followUpId,
        selectionEventId: selection.selectionEventId,
        workerId: selection.workerId,
        replyId: selection.replyId,
        replyEventId: reply.completedEventId,
        leaseHeadSha: selection.leaseHeadSha,
        reportSha256: digest(stableStringify(reply.report)),
        outcome: reply.report.status,
        counts: {
          files: reply.report.files.length,
          tests: reply.report.tests.length,
          risks: reply.report.risks.length,
        },
      },
      eventId: `${taskId}:scout-follow-up:${followUpId}:resolved:v1`,
    });
  }
}

export function buildFollowUpPrompt({ taskId, synthesisId, followUpId, check }) {
  return [
    `Resolve one human-selected read-only follow-up for task ${taskId}.`,
    `Synthesis: ${synthesisId}`,
    `Follow-up: ${followUpId}`,
    `Action: ${check.action}`,
    `Target: ${check.target}`,
    `Reason: ${check.reason}`,
    "Inspect or test only what is necessary for this check.",
    "Do not modify files, create commits, access GitHub, or broaden the task.",
    "Report the evidence, limitations, and remaining risk in the required worker report.",
  ].join("\n");
}

export class ScoutFollowUpError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ScoutFollowUpError";
  }
}

export class ScoutFollowUpAuthorityError extends ScoutFollowUpError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ScoutFollowUpAuthorityError";
  }
}

export class ScoutFollowUpConflictError extends ScoutFollowUpError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ScoutFollowUpConflictError";
  }
}

export class ScoutFollowUpRecoveryRequiredError extends ScoutFollowUpError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ScoutFollowUpRecoveryRequiredError";
  }
}

function findFollowUp(snapshot, followUpId) {
  const selection = (snapshot.scoutFollowUps || []).find(
    (candidate) => candidate.followUpId === followUpId,
  );
  if (!selection) throw new ScoutFollowUpError(`Unknown follow-up: ${followUpId}`);
  return selection;
}

function verifyExistingSelection(existing, expected) {
  const fields = [
    "synthesisId", "synthesisEventId", "synthesisArtifactSha256",
    "leaseHeadSha", "checkIndex", "checkSha256", "action", "workerId",
    "replyId", "promptSha256", "selectorType",
  ];
  if (fields.some((field) => existing[field] !== expected[field])) {
    throw new ScoutFollowUpConflictError(
      `Follow-up ${existing.followUpId} is already bound to a different check`,
    );
  }
}

function requireIdentifier(label, value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(value)) {
    throw new TypeError(`${label} must be 3-64 lowercase safe characters`);
  }
}

function requireHumanActor(value, firstmateActor) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("humanActor is required for follow-up selection");
  }
  if (value === firstmateActor) {
    throw new TypeError("humanActor must be distinct from the Firstmate actor");
  }
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
