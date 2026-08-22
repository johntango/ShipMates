import { createHash } from "node:crypto";
import path from "node:path";

const TERMINAL = new Set(["completed", "blocked"]);
export const DEFAULT_WORKSPACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_WORKSPACE_ABANDONMENT_MS = 30 * 24 * 60 * 60 * 1_000;

export class WorkflowWorkspaceMaintenance {
  constructor({ store, manager, clock = () => new Date(),
    retentionMs = DEFAULT_WORKSPACE_RETENTION_MS,
    abandonmentMs = DEFAULT_WORKSPACE_ABANDONMENT_MS,
    isProcessAlive = defaultIsProcessAlive } = {}) {
    if (!store || !manager) throw new TypeError("WorkflowWorkspaceMaintenance requires store and manager");
    this.store = store;
    this.manager = manager;
    this.clock = clock;
    this.retentionMs = retentionMs;
    this.abandonmentMs = abandonmentMs;
    this.isProcessAlive = isProcessAlive;
  }

  async inventory({ repoPath = null } = {}) {
    const resolvedRepo = repoPath ? path.resolve(repoPath) : null;
    const runs = (await this.store.list()).filter((run) =>
      !resolvedRepo || path.resolve(run.repoPath) === resolvedRepo);
    const items = [];
    for (const run of runs) items.push(await this.#inspect(run));
    return Object.freeze({
      generatedAt: this.clock().toISOString(),
      scope: resolvedRepo,
      items,
      counts: countStatuses(items),
    });
  }

  async clean({ repoPath = null, dryRun = false } = {}) {
    const before = await this.inventory({ repoPath });
    const reclaimed = [];
    const blocked = [];
    for (const item of before.items.filter(({ pendingReturnResult }) => pendingReturnResult)) {
      if (dryRun) continue;
      const run = await this.store.get(item.runId);
      await this.store.append(run.id, "workspace.returned", {
        worktreePath: run.workspace.binding.worktreePath,
        proof: run.workspace.returnIntent?.proof,
      }, "workspace-returned");
    }
    for (const item of before.items.filter(({ status }) => status === "safely reclaimable")) {
      if (dryRun) continue;
      try {
        let run = await this.store.get(item.runId);
        if (item.expiredAbandoned) {
          await this.store.append(run.id, "workspace.abandonment_recorded", {
            worktreePath: run.workspace.binding.worktreePath,
            headSha: run.workspace.binding.baseHeadSha,
            clean: true, noLiveProcess: true,
          }, "workspace-abandonment-recorded");
          run = await this.store.get(run.id);
        }
        const binding = run.workspace.binding;
        const proof = run.workspace.returnIntent?.proof || await this.manager.proveNoMutation({
          worktreePath: binding.worktreePath, expectedHeadSha: binding.baseHeadSha,
        });
        await this.store.append(run.id, "workspace.return_requested", {
          binding, reason: "Terminal clean base lease exceeded the local retention period", proof,
        }, "workspace-return-requested");
        await this.manager.returnLease({ worktreePath: binding.worktreePath, proof });
        await this.store.append(run.id, "workspace.returned", {
          worktreePath: binding.worktreePath, proof,
        }, "workspace-returned");
        reclaimed.push(item.runId);
      } catch {
        blocked.push(item.runId);
      }
    }
    return Object.freeze({ dryRun, before,
      eligibleCount: before.items.filter(({ status }) => status === "safely reclaimable").length,
      reclaimedCount: reclaimed.length, blockedCount: blocked.length,
      after: dryRun ? before : await this.inventory({ repoPath }) });
  }

  async previewWipe({ projectName, repoPath }) {
    requireProject(projectName, repoPath);
    const inventory = await this.inventory({ repoPath });
    const scopedRuns = (await this.store.list())
      .filter((run) => path.resolve(run.repoPath) === path.resolve(repoPath));
    const blockers = inventory.items.filter(({ status }) =>
      status !== "safely reclaimed" && status !== "no managed workspace");
    for (const run of scopedRuns.filter(({ phase }) => !TERMINAL.has(phase))) {
      blockers.push({ status: "active", reason: "A managed workflow is not terminal." });
    }
    const runSummaries = scopedRuns
      .map((run) => ({ phase: run.phase, updatedAt: run.updatedAt,
        hasEvidence: Boolean(run.worker || run.validation),
        specifications: artifactPaths(run).filter((value) => /(?:spec|adr)/iu.test(value)),
        managedBranches: [run.worker?.report?.branch].filter(Boolean),
        evidenceKinds: [run.worker && "implementer", run.validation && "validation"].filter(Boolean) }));
    const body = {
      schemaVersion: 1, projectName, repoPath: path.resolve(repoPath),
      generatedAt: this.clock().toISOString(), inventory: inventory.items.map(publicItem),
      workflows: runSummaries,
      proposed: ["archive managed WorkflowRun history and evidence index", "clear archived managed local state"],
      excluded: ["source checkout", "Git history", "shared branches", "remote branches", "publication"],
      blockers: blockers.map(({ status, reason }) => ({ status, reason })),
    };
    const digestBody = { ...body };
    delete digestBody.generatedAt;
    const token = createHash("sha256").update(stable(digestBody)).digest("hex").slice(0, 12);
    return Object.freeze({ ...body, token,
      confirmation: `WIPE-CLEAN ${projectName} ${token}`,
      canWipe: blockers.length === 0 && runSummaries.length > 0 });
  }

  async wipe({ projectName, repoPath, confirmation }) {
    const manifest = await this.previewWipe({ projectName, repoPath });
    if (confirmation !== manifest.confirmation) {
      throw new WorkflowWorkspaceMaintenanceError(
        `Confirmation did not match. To continue, enter exactly: ${manifest.confirmation}`,
      );
    }
    if (!manifest.canWipe) {
      throw new WorkflowWorkspaceMaintenanceError(
        "Wipe-clean is blocked because managed work must be preserved or cannot be proven safe",
      );
    }
    const runs = (await this.store.list()).filter((run) =>
      path.resolve(run.repoPath) === path.resolve(repoPath));
    const archiveName = `${safeSegment(projectName)}-${manifest.token}`;
    const archive = await this.store.archiveRuns({
      runIds: runs.map(({ id }) => id), archiveName, manifest,
    });
    return Object.freeze({ projectName, archived: runs.length,
      archivePath: archive.archiveRoot,
      message: "Managed local workflow state was archived. Source checkout and Git history were not changed." });
  }

  async #inspect(run) {
    const binding = run.workspace?.binding;
    if (!binding) return item(run, "no managed workspace",
      "No durable Treehouse lease binding is recorded; nothing will be reclaimed.");
    if (run.workspace.status === "returned") return item(run, "safely reclaimed",
      "The managed lease has a durable successful return result.", binding);
    if (run.worker?.receipt?.pid && this.isProcessAlive(run.worker.receipt.pid)) {
      return item(run, "active", "A known Implementer process is still live.", binding);
    }
    const ageMs = this.clock().getTime() - Date.parse(run.updatedAt);
    if (!TERMINAL.has(run.phase) && (!run.worker?.receipt?.pid ||
      !Number.isFinite(ageMs) || ageMs < this.abandonmentMs)) {
      return item(run, "active", "The owning workflow is not terminal; recovery will reattach instead of relaunching.", binding);
    }
    let lease;
    const leaseQuery = {
      repoPath: binding.repoPath, taskId: binding.runId, worktreePath: binding.worktreePath,
    };
    try { lease = await this.manager.findLease(leaseQuery); }
    catch {
      if (run.workspace.status === "returning") {
        try {
          const entry = await this.manager.findWorktree(leaseQuery);
          if (entry.state === "available") {
            return item(run, "safely reclaimed",
              "A previously requested return was observed as complete.", binding,
              { pendingReturnResult: true });
          }
        } catch { /* Preserve uncertain state. */ }
      }
      return item(run, "preserved for review",
        "Treehouse ownership could not be proven exactly; the workspace was preserved.", binding);
    }
    if (lease.leaseHolder !== run.id) return item(run, "preserved for review",
      "The lease holder does not match the owning workflow.", binding);
    let inspection;
    try { inspection = await this.manager.inspect({ worktreePath: binding.worktreePath }); }
    catch { return item(run, "preserved for review",
      "The workspace could not be inspected completely.", binding); }
    if (inspection.dirty) return item(run, "preserved for review",
      "The workspace contains uncommitted changes.", binding);
    if (inspection.headSha !== binding.baseHeadSha) {
      const knownCandidate = inspection.headSha === run.worker?.headSha;
      return item(run, "retained candidate", knownCandidate
        ? "A clean candidate commit is preserved for review or explicit delivery."
        : "The workspace advanced to an unrecognized head and was preserved.", binding);
    }
    if (!TERMINAL.has(run.phase)) return item(run, "safely reclaimable",
      "The workflow expired, its known process is gone, and its lease is clean at the exact base head.",
      binding, { expiredAbandoned: true });
    if (!Number.isFinite(ageMs) || ageMs < this.retentionMs) return item(run, "preserved for review",
      "The terminal clean workspace is still inside the local retention period.", binding);
    return item(run, "safely reclaimable",
      "The terminal lease is old enough, clean, at its exact base head, and has no live owner.", binding);
  }
}

export class WorkflowWorkspaceMaintenanceError extends Error {
  constructor(message) { super(message); this.name = "WorkflowWorkspaceMaintenanceError"; }
}

export function renderWorkspaceInventory(report) {
  const lines = ["Workspace maintenance inventory:"];
  for (const [status, count] of Object.entries(report.counts)) {
    if (count) lines.push(`${status}: ${count}`);
  }
  for (const entry of report.items) lines.push(`- ${entry.status}: ${entry.reason}`);
  lines.push("Clean is safe maintenance; it preserves history, candidates, uncertain work, and the shared checkout.");
  lines.push("Wipe-clean is a separate destructive reset and always requires a named scope, dry-run manifest, and exact confirmation.");
  return lines.join("\n");
}

export function renderCleanReport(result) {
  const summary = result.dryRun
    ? `Clean project dry run: ${result.eligibleCount} workspace${result.eligibleCount === 1 ? "" : "s"} would be reclaimed; nothing changed.`
    : `Clean project completed: ${result.reclaimedCount} workspace${result.reclaimedCount === 1 ? "" : "s"} reclaimed; ${result.blockedCount} return${result.blockedCount === 1 ? " was" : "s were"} blocked safely.`;
  return `${summary}\n${renderWorkspaceInventory(result.after)}`;
}

export function renderWipeManifest(manifest) {
  return [
    `Wipe-clean dry run for ${manifest.projectName}.`,
    `Scope: managed local WorkflowRun state for ${manifest.repoPath}.`,
    "Risk: confirmed reset archives managed workflow state; it never deletes the source checkout, rewrites Git history, changes shared branches, or performs remote actions.",
    `Preserved/blocking items: ${manifest.blockers.length}.`,
    manifest.canWipe
      ? `To confirm this exact manifest, enter: ${manifest.confirmation}`
      : "Wipe-clean is blocked. Resolve or explicitly preserve every listed uncertain/active/candidate workspace, then request a new dry run.",
    "To abort, do nothing or say: abort wipe-clean.",
  ].join("\n");
}

export function renderWipeResult(result) { return result.message; }

function item(run, status, reason, binding = null, extra = {}) {
  return Object.freeze({ runId: run.id, status, reason,
    repoPath: run.repoPath, worktreePath: binding?.worktreePath || null, ...extra });
}
function publicItem({ status, reason, worktreePath }) { return { status, reason, worktreePath }; }
function countStatuses(items) {
  return Object.freeze(items.reduce((counts, { status }) =>
    ({ ...counts, [status]: (counts[status] || 0) + 1 }), {}));
}
function artifactPaths(run) {
  return [run.worker?.report?.files, run.worker?.report?.artifacts]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .map((value) => typeof value === "string" ? value : value?.path)
    .filter((value) => typeof value === "string");
}
function requireProject(name, repoPath) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._ -]{1,80}$/u.test(name) ||
    typeof repoPath !== "string" || !path.isAbsolute(repoPath)) {
    throw new WorkflowWorkspaceMaintenanceError("Wipe-clean requires a named project and absolute repository scope");
  }
}
function safeSegment(value) { return value.toLowerCase().replaceAll(/[^a-z0-9._-]+/gu, "-").slice(0, 64); }
function stable(value) { return JSON.stringify(canonical(value)); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function defaultIsProcessAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
