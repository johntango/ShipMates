import { randomUUID } from "node:crypto";
import path from "node:path";

export class TreehouseLedgerWorkflow {
  constructor({ store, manager, actor = "firstmate", idFactory = randomUUID }) {
    if (!store || !manager) {
      throw new TypeError("TreehouseLedgerWorkflow requires store and manager");
    }
    if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
    this.store = store;
    this.manager = manager;
    this.actor = actor;
    this.idFactory = idFactory;
  }

  async acquire({ taskId, repoPath }) {
    const resolvedRepoPath = path.resolve(repoPath);
    let snapshot = await this.store.getSnapshot(taskId);

    if (snapshot.state === "approved_for_dispatch") {
      snapshot = await this.#transition(
        taskId,
        "approved_for_dispatch",
        "preparing",
        "Treehouse lease preparation started",
      );
    }

    if (snapshot.state === "running" && snapshot.worktree?.status === "leased") {
      return snapshot;
    }
    requireState(snapshot, "preparing");

    if (snapshot.worktree?.status === "leased") {
      return this.#transition(
        taskId,
        "preparing",
        "running",
        "Treehouse lease verified and recorded",
      );
    }

    let requestedHere = false;
    if (snapshot.worktree === null) {
      await this.manager.prepareRepository({ repoPath: resolvedRepoPath });
      snapshot = await this.store.requestWorktreeLease({
        taskId,
        actor: this.actor,
        repoPath: resolvedRepoPath,
        baseSha: snapshot.baseSha,
        eventId: operationId(taskId, "lease-request"),
      });
      requestedHere = true;
    }

    if (snapshot.worktree.status !== "lease_requested") {
      throw new TreehouseWorkflowError(
        `Cannot acquire from worktree status ${snapshot.worktree.status}`,
      );
    }
    if (snapshot.worktree.repoPath !== resolvedRepoPath) {
      throw new TreehouseWorkflowError(
        "Repository path differs from the durable lease request",
      );
    }
    if (!requestedHere) {
      throw new TreehouseRecoveryRequiredError(
        "A lease request has no recorded result; reconcile the existing Treehouse lease instead of acquiring again",
      );
    }

    const lease = await this.manager.lease({
      repoPath: resolvedRepoPath,
      taskId,
    });
    const inspection = await this.manager.inspect({
      worktreePath: lease.worktreePath,
    });
    verifyLeasedInspection(snapshot, inspection);

    await this.#recordLease(taskId, snapshot, resolvedRepoPath, inspection);
    return this.#transition(
      taskId,
      "preparing",
      "running",
      "Treehouse lease verified and recorded",
    );
  }

  async reconcileAcquisition({ taskId, repoPath, worktreePath }) {
    const resolvedRepoPath = path.resolve(repoPath);
    const resolvedWorktreePath = path.resolve(worktreePath);
    const snapshot = await this.store.getSnapshot(taskId);
    requireState(snapshot, "preparing");
    if (
      snapshot.worktree?.status !== "lease_requested" ||
      snapshot.worktree.repoPath !== resolvedRepoPath
    ) {
      throw new TreehouseWorkflowError(
        "Task does not have a matching unresolved lease request",
      );
    }

    await this.manager.findLease({
      repoPath: resolvedRepoPath,
      taskId,
      worktreePath: resolvedWorktreePath,
    });
    const inspection = await this.manager.inspect({
      worktreePath: resolvedWorktreePath,
    });
    verifyLeasedInspection(snapshot, inspection);
    await this.#recordLease(taskId, snapshot, resolvedRepoPath, inspection);
    return this.#transition(
      taskId,
      "preparing",
      "running",
      "Uncertain Treehouse lease reconciled",
    );
  }

  async completeNoMutation({ taskId }) {
    let snapshot = await this.store.getSnapshot(taskId);
    if (snapshot.state === "complete" && snapshot.worktree?.status === "returned") {
      return snapshot;
    }
    if (snapshot.state === "running") {
      snapshot = await this.#transition(
        taskId,
        "running",
        "validating",
        "No-mutation proof started",
      );
    }

    if (snapshot.state === "validating" && snapshot.worktree?.proof === null) {
      if (snapshot.worktree?.status !== "leased") {
        throw new TreehouseWorkflowError("No active lease is available to prove");
      }
      const proof = await this.manager.proveNoMutation({
        worktreePath: snapshot.worktree.worktreePath,
        expectedHeadSha: snapshot.baseSha,
      });
      snapshot = await this.store.recordWorktreeProof({
        taskId,
        actor: this.actor,
        proof,
        eventId: operationId(taskId, "no-mutation-proof"),
      });
    }

    if (snapshot.state === "validating") {
      if (snapshot.worktree?.proof?.kind !== "no-mutation") {
        throw new TreehouseWorkflowError("A verified no-mutation proof is required");
      }
      snapshot = await this.#transition(
        taskId,
        "validating",
        "cleaning",
        "No-mutation proof recorded",
      );
    }

    requireState(snapshot, "cleaning");
    if (snapshot.worktree.status === "returned") {
      return this.#transition(
        taskId,
        "cleaning",
        "complete",
        "Treehouse return recorded",
      );
    }

    let requestedHere = false;
    if (snapshot.worktree.status === "leased") {
      snapshot = await this.store.requestWorktreeReturn({
        taskId,
        actor: this.actor,
        worktreePath: snapshot.worktree.worktreePath,
        proofEventId: snapshot.worktree.proof.eventId,
        eventId: operationId(taskId, "return-request"),
      });
      requestedHere = true;
    }
    if (snapshot.worktree.status !== "return_requested") {
      throw new TreehouseWorkflowError(
        `Cannot return worktree from status ${snapshot.worktree.status}`,
      );
    }
    if (!requestedHere) {
      throw new TreehouseRecoveryRequiredError(
        "A return request has no recorded result; reconcile Treehouse status instead of returning again",
      );
    }

    await this.manager.returnLease({
      worktreePath: snapshot.worktree.worktreePath,
      proof: snapshot.worktree.proof,
    });
    snapshot = await this.store.recordWorktreeReturn({
      taskId,
      actor: this.actor,
      worktreePath: snapshot.worktree.worktreePath,
      requestEventId: snapshot.worktree.returnRequestEventId,
      eventId: operationId(taskId, "returned"),
    });
    return this.#transition(
      taskId,
      "cleaning",
      "complete",
      "Treehouse return recorded",
    );
  }

  async completeExactTreeLanding({ taskId, operationId }) {
    let snapshot = await this.store.getSnapshot(taskId);
    if (snapshot.state === "complete" && snapshot.worktree?.status === "returned") {
      return snapshot;
    }
    const assurance = (snapshot.postMergeAssurances || []).find(
      ({ operationId: id }) => id === operationId,
    );
    if (!assurance || assurance.requiredChecks?.satisfied !== true) {
      throw new TreehouseWorkflowError(
        "Exact-tree landing requires passing merge-commit assurance evidence",
      );
    }

    if (snapshot.state === "landed" && snapshot.worktree?.proof === null) {
      if (snapshot.worktree?.status !== "leased") {
        throw new TreehouseWorkflowError("No active lease is available to prove");
      }
      await this.manager.fetchExactCommit({
        worktreePath: snapshot.worktree.worktreePath,
        commitSha: assurance.mergeCommitSha,
      });
      const proof = await this.manager.proveExactTreeLanding({
        worktreePath: snapshot.worktree.worktreePath,
        approvedHeadSha: assurance.approvedHeadSha,
        mergedCommitSha: assurance.mergeCommitSha,
        remoteMainSha: assurance.baseHeadSha,
      });
      snapshot = await this.store.recordWorktreeProof({
        taskId,
        actor: this.actor,
        proof: { ...proof, assuranceEventId: assurance.eventId },
        eventId: `${taskId}:post-merge:${operationId}:tree-proof:v1`,
      });
    }

    if (snapshot.state === "landed") {
      if (snapshot.worktree?.proof?.kind !== "exact-tree-landing" ||
        snapshot.worktree.proof.assuranceEventId !== assurance.eventId) {
        throw new TreehouseWorkflowError(
          "A matching exact-tree landing proof is required",
        );
      }
      snapshot = await this.store.transition({
        taskId,
        from: "landed",
        to: "cleaning",
        reason: "Merge-commit CI and exact-tree landing verified",
        actor: this.actor,
        eventId: `${taskId}:post-merge:${operationId}:state-cleaning:v1`,
      });
    }

    requireState(snapshot, "cleaning");
    if (snapshot.worktree.status === "returned") {
      return this.store.transition({
        taskId,
        from: "cleaning",
        to: "complete",
        reason: "Treehouse return recorded after landed-work proof",
        actor: this.actor,
        eventId: `${taskId}:post-merge:${operationId}:state-complete:v1`,
      });
    }

    let requestedHere = false;
    if (snapshot.worktree.status === "leased") {
      snapshot = await this.store.requestWorktreeReturn({
        taskId,
        actor: this.actor,
        worktreePath: snapshot.worktree.worktreePath,
        proofEventId: snapshot.worktree.proof.eventId,
        eventId: `${taskId}:post-merge:${operationId}:return-request:${this.idFactory()}:v1`,
      });
      requestedHere = true;
    }
    if (snapshot.worktree.status !== "return_requested") {
      throw new TreehouseWorkflowError(
        `Cannot return worktree from status ${snapshot.worktree.status}`,
      );
    }
    if (!requestedHere) {
      throw new TreehouseRecoveryRequiredError(
        "A return request has no recorded result; reconcile Treehouse status instead of returning again",
      );
    }

    await this.manager.returnLease({
      worktreePath: snapshot.worktree.worktreePath,
      proof: snapshot.worktree.proof,
    });
    snapshot = await this.store.recordWorktreeReturn({
      taskId,
      actor: this.actor,
      worktreePath: snapshot.worktree.worktreePath,
      requestEventId: snapshot.worktree.returnRequestEventId,
      eventId: `${taskId}:post-merge:${operationId}:returned:v1`,
    });
    return this.store.transition({
      taskId,
      from: "cleaning",
      to: "complete",
      reason: "Treehouse return recorded after landed-work proof",
      actor: this.actor,
      eventId: `${taskId}:post-merge:${operationId}:state-complete:v1`,
    });
  }

  async reconcileReturn({ taskId }) {
    const snapshot = await this.store.getSnapshot(taskId);
    requireState(snapshot, "cleaning");
    if (snapshot.worktree?.status !== "return_requested") {
      throw new TreehouseWorkflowError(
        "Task does not have an unresolved Treehouse return request",
      );
    }
    const entry = await this.manager.findWorktree({
      repoPath: snapshot.worktree.repoPath,
      worktreePath: snapshot.worktree.worktreePath,
    });
    if (entry.state !== "available" || entry.leaseHolder !== null) {
      throw new TreehouseRecoveryRequiredError(
        `Treehouse still reports state=${entry.state}, holder=${entry.leaseHolder || "none"}`,
      );
    }

    await this.store.recordWorktreeReturn({
      taskId,
      actor: this.actor,
      worktreePath: snapshot.worktree.worktreePath,
      requestEventId: snapshot.worktree.returnRequestEventId,
      eventId: operationId(taskId, "returned"),
    });
    return this.#transition(
      taskId,
      "cleaning",
      "complete",
      "Treehouse return reconciled",
    );
  }

  async #recordLease(taskId, snapshot, repoPath, inspection) {
    return this.store.recordWorktreeLease({
      taskId,
      actor: this.actor,
      requestEventId: snapshot.worktree.leaseRequestEventId,
      repoPath,
      worktreePath: inspection.worktreePath,
      headSha: inspection.headSha,
      branch: inspection.branch,
      eventId: operationId(taskId, "leased"),
    });
  }

  async #transition(taskId, from, to, reason) {
    return this.store.transition({
      taskId,
      from,
      to,
      reason,
      actor: this.actor,
      eventId: operationId(taskId, `state-${to}`),
    });
  }
}

export class TreehouseWorkflowError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "TreehouseWorkflowError";
  }
}

export class TreehouseRecoveryRequiredError extends TreehouseWorkflowError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "TreehouseRecoveryRequiredError";
  }
}

function operationId(taskId, operation) {
  return `${taskId}:treehouse:${operation}:v1`;
}

function requireState(snapshot, expected) {
  if (snapshot.state !== expected) {
    throw new TreehouseWorkflowError(
      `Task ${snapshot.id} must be ${expected}, found ${snapshot.state}`,
    );
  }
}

function verifyLeasedInspection(snapshot, inspection) {
  if (inspection.dirty || inspection.headSha !== snapshot.baseSha) {
    throw new TreehouseWorkflowError(
      `Leased worktree must be clean at ${snapshot.baseSha}; found ${inspection.headSha}${inspection.dirty ? " with local changes" : ""}`,
    );
  }
}
