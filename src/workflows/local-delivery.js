import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class LocalDeliveryWorkflow {
  constructor({ store, runGit = defaultRunGit, actor = "firstmate" } = {}) {
    if (!store || typeof runGit !== "function") {
      throw new TypeError("LocalDeliveryWorkflow requires store and runGit");
    }
    this.store = store;
    this.runGit = runGit;
    this.actor = actor;
  }

  async deliver({ taskId }) {
    let snapshot = await this.store.getSnapshot(taskId);
    const target = requireValidatedTarget(snapshot);
    const destination = await inspect(this.runGit, target.repoPath);
    if (destination.headSha === target.headSha) return { snapshot, reused: true, ...target };
    if (destination.headSha !== target.baseSha) {
      throw new LocalDeliveryError(
        `Local checkout moved from task base ${target.baseSha} to ${destination.headSha}`,
      );
    }
    if (!destination.clean) {
      throw new LocalDeliveryError(
        "Local checkout has uncommitted or untracked changes; delivery was not attempted",
      );
    }
    const source = await inspect(this.runGit, target.worktreePath);
    if (!source.clean || source.headSha !== target.headSha) {
      throw new LocalDeliveryError("Validated task worktree no longer matches its exact commit");
    }

    await this.runGit(target.repoPath, ["merge", "--ff-only", target.headSha]);
    const delivered = await inspect(this.runGit, target.repoPath);
    if (!delivered.clean || delivered.headSha !== target.headSha) {
      throw new LocalDeliveryError("Local delivery did not land the exact validated commit");
    }
    snapshot = await this.store.recordEvidence({
      taskId,
      actor: this.actor,
      kind: "local-delivery",
      value: JSON.stringify({
        repoPath: target.repoPath,
        baseSha: target.baseSha,
        headSha: target.headSha,
        method: "fast-forward",
      }),
      eventId: `${taskId}:local-delivery:${target.headSha}:v1`,
    });
    snapshot = await completeLocally(this.store, snapshot, this.actor, taskId);
    return { snapshot, reused: false, ...target };
  }
}

export class LocalDeliveryError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "LocalDeliveryError";
  }
}

export function canDeliverLocally(snapshot) {
  try {
    requireValidatedTarget(snapshot);
    return true;
  } catch {
    return false;
  }
}

function requireValidatedTarget(snapshot) {
  const validation = snapshot?.validationRuns?.at(-1);
  const commit = snapshot?.gitCommits?.at(-1);
  const worktree = snapshot?.worktree;
  if (validation?.passed !== true || commit?.status !== "completed" ||
    worktree?.status !== "leased" ||
    validation.finalHeadSha !== worktree.headSha ||
    commit.result?.headSha !== worktree.headSha ||
    commit.result?.baseHeadSha !== snapshot.baseSha ||
    typeof worktree.repoPath !== "string" || typeof worktree.worktreePath !== "string") {
    throw new LocalDeliveryError(
      "Local delivery requires an active lease and the exact no-mistakes-validated task commit",
    );
  }
  return {
    repoPath: worktree.repoPath,
    worktreePath: worktree.worktreePath,
    baseSha: snapshot.baseSha,
    headSha: worktree.headSha,
  };
}

async function inspect(runGit, cwd) {
  const [headSha, status] = await Promise.all([
    runGit(cwd, ["rev-parse", "HEAD"]),
    runGit(cwd, ["status", "--porcelain=v1", "-z"]),
  ]);
  return { headSha: headSha.trim(), clean: status.length === 0 };
}

async function defaultRunGit(cwd, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

async function completeLocally(store, snapshot, actor, taskId) {
  const path = {
    validating: ["awaiting_human", "ready_to_merge", "merging", "landed", "cleaning", "complete"],
    awaiting_human: ["ready_to_merge", "merging", "landed", "cleaning", "complete"],
    ready_to_merge: ["merging", "landed", "cleaning", "complete"],
    merging: ["landed", "cleaning", "complete"],
    landed: ["cleaning", "complete"],
    cleaning: ["complete"],
    complete: [],
  }[snapshot.state];
  if (!path) throw new LocalDeliveryError(`Cannot complete local delivery from ${snapshot.state}`);
  for (const to of path) {
    const from = snapshot.state;
    snapshot = await store.transition({
      taskId,
      from,
      to,
      actor,
      reason: "Exact validated commit delivered to the local checkout",
      eventId: `${taskId}:local-delivery:${from}-to-${to}:v1`,
    });
  }
  return snapshot;
}
