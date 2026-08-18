import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const terminalStates = new Set(["complete", "failed", "cancelled"]);

export class TreehouseCapacityBlockedError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "TreehouseCapacityBlockedError";
  }
}

export class TreehouseLeaseReconciler {
  constructor({
    stores, manager, actor = "firstmate-lease-reconciler",
    abandonedAfterMs = 24 * 60 * 60 * 1_000,
    clock = () => new Date(), isOwnerLive = processOwnsTask,
  } = {}) {
    if (!Array.isArray(stores) || stores.length === 0 || !manager) {
      throw new TypeError("Treehouse lease reconciliation requires stores and a manager");
    }
    this.stores = stores;
    this.manager = manager;
    this.actor = actor;
    this.abandonedAfterMs = abandonedAfterMs;
    this.clock = clock;
    this.isOwnerLive = isOwnerLive;
  }

  async ensureCapacity({ repoPath }) {
    const entries = await this.manager.list({ repoPath });
    if (entries.length === 0 || entries.some(({ state }) => state === "available")) {
      return { released: [], preserved: [] };
    }

    const result = await this.reconcileEligible({ repoPath, entries });
    if (result.released.length === 0) {
      throw new TreehouseCapacityBlockedError(
        "Treehouse capacity is unavailable. Every occupied lease is active, dirty, recent, unknown, or awaiting safe reconciliation; no ambiguous worktree was returned.",
      );
    }
    return result;
  }

  async reconcileEligible({ repoPath, entries = null }) {
    const observedEntries = entries || await this.manager.list({ repoPath });
    const released = [];
    const preserved = [];
    for (const entry of observedEntries.filter(({ state }) => state === "leased")) {
      const owner = await this.#findOwner(entry);
      if (!owner) {
        preserved.push({ entry, reason: "no matching durable task ledger" });
        continue;
      }
      const { store, snapshot } = owner;
      if (await this.isOwnerLive(snapshot.id)) {
        preserved.push({ entry, reason: "owning process is live" });
        continue;
      }
      const ageMs = this.clock().getTime() - Date.parse(snapshot.lastEventAt);
      if (!terminalStates.has(snapshot.state) &&
        (!Number.isFinite(ageMs) || ageMs < this.abandonedAfterMs)) {
        preserved.push({ entry, reason: "owner is recent or ambiguous" });
        continue;
      }

      try {
        const result = await this.#releaseProvenOwner({ store, snapshot, entry });
        if (result) released.push(result);
      } catch (error) {
        preserved.push({ entry, reason: error.message });
      }
    }

    return { released, preserved };
  }

  async #findOwner(entry) {
    if (!entry.leaseHolder) return null;
    for (const store of this.stores) {
      try {
        const snapshot = await store.getSnapshot(entry.leaseHolder);
        if (snapshot.worktree?.worktreePath === entry.worktreePath &&
          snapshot.worktree?.repoPath && snapshot.worktree.status !== "returned") {
          return { store, snapshot };
        }
      } catch (error) {
        if (error?.code !== "ENOENT") continue;
      }
    }
    return null;
  }

  async #releaseProvenOwner({ store, snapshot, entry }) {
    if (snapshot.worktree.status === "return_requested") {
      const observed = await this.manager.findWorktree({
        repoPath: snapshot.worktree.repoPath,
        worktreePath: entry.worktreePath,
      });
      if (observed.state !== "available" || observed.leaseHolder !== null) {
        throw new TreehouseCapacityBlockedError(
          "A prior return has an uncertain result; preserving its lease",
        );
      }
      await store.recordWorktreeReturn({
        taskId: snapshot.id,
        actor: this.actor,
        worktreePath: entry.worktreePath,
        requestEventId: snapshot.worktree.returnRequestEventId,
        eventId: `${snapshot.id}:lease-recycler:returned:v1`,
      });
      return { taskId: snapshot.id, worktreePath: entry.worktreePath, reconciled: true };
    }
    if (snapshot.worktree.status !== "leased") {
      throw new TreehouseCapacityBlockedError("Durable lease state is ambiguous");
    }

    const proof = await this.manager.proveNoMutation({
      worktreePath: entry.worktreePath,
      expectedHeadSha: snapshot.baseSha,
    });
    if (!snapshot.worktree.proof) {
      snapshot = await store.recordWorktreeProof({
        taskId: snapshot.id,
        actor: this.actor,
        proof,
        eventId: `${snapshot.id}:lease-recycler:no-mutation:v1`,
      });
    } else if (snapshot.worktree.proof.kind !== "no-mutation" ||
      snapshot.worktree.proof.verified !== true) {
      throw new TreehouseCapacityBlockedError("Existing lease proof is not a no-mutation proof");
    }

    if (!terminalStates.has(snapshot.state) && snapshot.state !== "blocked") {
      snapshot = await store.transition({
        taskId: snapshot.id,
        from: snapshot.state,
        to: "blocked",
        actor: this.actor,
        reason: "Abandoned execution had no live owner and an exact no-mutation proof; its lease was safely recycled",
        eventId: `${snapshot.id}:lease-recycler:blocked:v1`,
      });
    }
    snapshot = await store.requestWorktreeReturn({
      taskId: snapshot.id,
      actor: this.actor,
      worktreePath: entry.worktreePath,
      proofEventId: snapshot.worktree.proof.eventId,
      eventId: `${snapshot.id}:lease-recycler:return-request:v1`,
    });
    await this.manager.returnLease({
      worktreePath: entry.worktreePath,
      proof: snapshot.worktree.proof,
    });
    await store.recordWorktreeReturn({
      taskId: snapshot.id,
      actor: this.actor,
      worktreePath: entry.worktreePath,
      requestEventId: snapshot.worktree.returnRequestEventId,
      eventId: `${snapshot.id}:lease-recycler:returned:v1`,
    });
    return { taskId: snapshot.id, worktreePath: entry.worktreePath, reconciled: false };
  }
}

async function processOwnsTask(taskId) {
  const { stdout } = await execFile("ps", ["-axo", "command="], {
    encoding: "utf8",
    timeout: 5_000,
  });
  const token = new RegExp(`(?:^|\\s)${escapeRegex(taskId)}(?:\\s|$)`, "u");
  return stdout.split(/\r?\n/u).some((line) => token.test(line));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
