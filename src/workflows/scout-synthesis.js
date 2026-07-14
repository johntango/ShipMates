import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export class ScoutSynthesisWorkflow {
  constructor({ store, actor = "firstmate" } = {}) {
    if (!store || typeof store.getSnapshot !== "function" ||
      typeof store.recordScoutSynthesis !== "function") {
      throw new TypeError("ScoutSynthesisWorkflow requires a writable task store");
    }
    this.store = store;
    this.actor = actor;
  }

  async run({ taskId, synthesisId, workerIds }) {
    validateInputs({ synthesisId, workerIds });
    let snapshot = await this.store.getSnapshot(taskId);
    const existing = (snapshot.scoutSyntheses || []).find((item) =>
      item.synthesisId === synthesisId);
    if (existing) {
      if (!sameArray(existing.workerIds, workerIds)) {
        throw new ScoutSynthesisConflictError(
          `Synthesis ${synthesisId} is already bound to different workers`,
        );
      }
      return {
        snapshot,
        artifact: await loadScoutSynthesisArtifact({
          store: this.store,
          snapshot,
          record: existing,
        }),
        reused: true,
      };
    }

    const workers = requireVerifiedPair(snapshot, workerIds);
    const artifact = buildScoutSynthesis({
      taskId,
      synthesisId,
      leaseHeadSha: snapshot.worktree.headSha,
      workers,
    });
    const content = `${stableStringify(artifact)}\n`;
    const artifactSha256 = digest(content);
    const artifactPath = relativeArtifactPath(taskId, synthesisId);
    await writeAtomicArtifact(
      path.join(this.store.rootDir, artifactPath),
      content,
    );
    const counts = {
      agreements: artifact.agreements.length,
      disagreements: artifact.disagreements.length,
      followUpChecks: artifact.followUpChecks.length,
      unsupportedClaims: artifact.unsupportedClaims.length,
    };
    snapshot = await this.store.recordScoutSynthesis({
      taskId,
      actor: this.actor,
      synthesis: {
        synthesisId,
        workerIds: [...workerIds],
        sourceReportEventIds: workers.map(({ reportEventId }) => reportEventId),
        leaseHeadSha: artifact.leaseHeadSha,
        artifactPath,
        artifactSha256,
        outcome: artifact.outcome,
        counts,
      },
      eventId: `${taskId}:scout-synthesis:${synthesisId}:v1`,
    });
    return { snapshot, artifact, reused: false };
  }

}

export async function loadScoutSynthesisArtifact({ store, snapshot, record }) {
  if (!store?.rootDir || !snapshot || !record) {
    throw new TypeError("Loading a synthesis artifact requires store, snapshot, and record");
  }
  let content;
  try {
    content = await readFile(path.join(store.rootDir, record.artifactPath), "utf8");
  } catch (cause) {
    throw new ScoutSynthesisArtifactError("Bound synthesis artifact is missing", {
      cause,
    });
  }
  if (digest(content) !== record.artifactSha256) {
    throw new ScoutSynthesisArtifactError("Bound synthesis artifact digest changed");
  }
  let artifact;
  try {
    artifact = JSON.parse(content);
  } catch (cause) {
    throw new ScoutSynthesisArtifactError("Bound synthesis artifact is invalid JSON", {
      cause,
    });
  }
  validateLoadedArtifact(artifact, snapshot, record);
  return artifact;
}

export function buildScoutSynthesis({ taskId, synthesisId, leaseHeadSha, workers }) {
  if (!Array.isArray(workers) || workers.length !== 2) {
    throw new TypeError("Synthesis requires exactly two worker records");
  }
  const [left, right] = workers;
  const agreements = [];
  const disagreements = [];
  const unsupportedClaims = [];
  const followUpChecks = [];

  compareScalar("status", left.report.status, right.report.status);
  compareScalar("branch", left.report.branch, right.report.branch);
  compareScalar("commit", left.report.commit, right.report.commit);

  if (left.report.summary === right.report.summary) {
    agreement("summary", "summary", left.report.summary);
  } else {
    unsupported(left.id, "summary", left.report.summary);
    unsupported(right.id, "summary", right.report.summary);
  }

  compareStringSets("file", left.report.files, right.report.files);
  compareStringSets("risk", left.report.risks, right.report.risks);
  compareTests(left.report.tests, right.report.tests);

  const sortedAgreements = sortObjects(agreements);
  const sortedDisagreements = sortObjects(disagreements);
  const sortedUnsupported = sortObjects(unsupportedClaims);
  const sortedChecks = sortObjects(uniqueObjects(followUpChecks));
  return {
    schemaVersion: 1,
    taskId,
    synthesisId,
    leaseHeadSha,
    sources: workers.map((worker) => ({
      workerId: worker.id,
      threadId: worker.threadId,
      reportEventId: worker.reportEventId,
      reportSha256: digest(stableStringify(worker.report)),
      verification: {
        noMutation: worker.verification.noMutation,
        headSha: worker.verification.headSha,
        dirty: worker.verification.dirty,
        paneId: worker.verification.paneId ?? null,
      },
      report: structuredClone(worker.report),
    })),
    agreements: sortedAgreements,
    disagreements: sortedDisagreements,
    unsupportedClaims: sortedUnsupported,
    followUpChecks: sortedChecks,
    outcome: sortedDisagreements.length === 0 && sortedUnsupported.length === 0
      ? "aligned"
      : "review_required",
  };

  function compareScalar(kind, first, second) {
    if (first === second) agreement(kind, kind, first);
    else disagreement(kind, kind, first, second);
  }

  function compareStringSets(kind, firstValues, secondValues) {
    const first = new Set(firstValues);
    const second = new Set(secondValues);
    for (const value of [...new Set([...first, ...second])].sort()) {
      if (first.has(value) && second.has(value)) agreement(kind, value, value);
      else unsupported(first.has(value) ? left.id : right.id, kind, value);
    }
  }

  function compareTests(firstTests, secondTests) {
    const first = testsByCommand(firstTests);
    const second = testsByCommand(secondTests);
    for (const command of [...new Set([...first.keys(), ...second.keys()])].sort()) {
      const firstResult = first.get(command);
      const secondResult = second.get(command);
      if (firstResult !== undefined && secondResult !== undefined) {
        if (firstResult === secondResult) {
          agreement("test", command, `${command} => ${firstResult}`);
        } else {
          disagreement("test", command, firstResult, secondResult);
        }
      } else {
        const worker = firstResult !== undefined ? left : right;
        const result = firstResult ?? secondResult;
        unsupported(worker.id, "test", `${command} => ${result}`);
      }
    }
  }

  function agreement(kind, key, claim) {
    agreements.push({ kind, key, claim, workerIds: [left.id, right.id] });
  }

  function disagreement(kind, key, first, second) {
    disagreements.push({
      kind,
      key,
      values: [
        { workerId: left.id, value: first },
        { workerId: right.id, value: second },
      ],
    });
    followUpChecks.push({
      action: kind === "test" ? "rerun_test" : "inspect_conflict",
      target: key,
      reason: `workers_disagree_on_${kind}`,
    });
  }

  function unsupported(workerId, kind, claim) {
    unsupportedClaims.push({
      workerId,
      kind,
      claim,
      reason: "not_corroborated_by_peer_report",
    });
    followUpChecks.push({
      action: kind === "test" ? "run_test" : kind === "file" ? "inspect_file" :
        kind === "risk" ? "investigate_risk" : "inspect_summary_sources",
      target: claim,
      reason: "peer_report_did_not_corroborate",
    });
  }
}

export class ScoutSynthesisError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ScoutSynthesisError";
  }
}

export class ScoutSynthesisAuthorityError extends ScoutSynthesisError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ScoutSynthesisAuthorityError";
  }
}

export class ScoutSynthesisConflictError extends ScoutSynthesisError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ScoutSynthesisConflictError";
  }
}

export class ScoutSynthesisArtifactError extends ScoutSynthesisError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ScoutSynthesisArtifactError";
  }
}

function requireVerifiedPair(snapshot, workerIds) {
  if (!snapshot.worktree?.headSha) {
    throw new ScoutSynthesisAuthorityError("Task has no durable worktree authority");
  }
  const workers = workerIds.map((workerId) =>
    snapshot.workers.find(({ id }) => id === workerId));
  for (const [index, worker] of workers.entries()) {
    if (!worker || worker.status !== "reported" || worker.mode !== "scout" ||
      worker.sandbox !== "read-only" || !worker.threadId || !worker.reportEventId ||
      worker.verification?.noMutation !== true ||
      worker.verification?.dirty !== false ||
      worker.verification?.headSha !== snapshot.worktree.headSha ||
      worker.report?.taskId !== snapshot.id) {
      throw new ScoutSynthesisAuthorityError(
        `Worker is not a verified terminal read-only scout: ${workerIds[index]}`,
      );
    }
  }
  if (workers[0].worktreePath !== workers[1].worktreePath ||
    workers[0].worktreePath !== snapshot.worktree.worktreePath) {
    throw new ScoutSynthesisAuthorityError("Scout reports have different worktree authority");
  }
  return workers;
}

function validateInputs({ synthesisId, workerIds }) {
  if (typeof synthesisId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(synthesisId)) {
    throw new TypeError("synthesisId must be 3-64 lowercase safe characters");
  }
  if (!Array.isArray(workerIds) || workerIds.length !== 2 ||
    new Set(workerIds).size !== 2 ||
    workerIds.some((value) => typeof value !== "string" || value.trim() === "")) {
    throw new TypeError("Exactly two unique worker IDs are required");
  }
}

function testsByCommand(tests) {
  const result = new Map();
  for (const test of tests) {
    if (result.has(test.command)) {
      throw new ScoutSynthesisConflictError(
        `Worker report repeats test command: ${test.command}`,
      );
    }
    result.set(test.command, test.result);
  }
  return result;
}

function validateLoadedArtifact(artifact, snapshot, record) {
  if (!artifact || artifact.schemaVersion !== 1 ||
    artifact.taskId !== snapshot.id || artifact.synthesisId !== record.synthesisId ||
    artifact.leaseHeadSha !== record.leaseHeadSha ||
    artifact.outcome !== record.outcome || !Array.isArray(artifact.sources) ||
    artifact.sources.map(({ workerId }) => workerId).join(",") !==
      record.workerIds.join(",") ||
    artifact.sources.map(({ reportEventId }) => reportEventId).join(",") !==
      record.sourceReportEventIds.join(",")) {
    throw new ScoutSynthesisArtifactError("Bound synthesis artifact identity is invalid");
  }
  const counts = {
    agreements: artifact.agreements?.length,
    disagreements: artifact.disagreements?.length,
    followUpChecks: artifact.followUpChecks?.length,
    unsupportedClaims: artifact.unsupportedClaims?.length,
  };
  if (stableStringify(counts) !== stableStringify(record.counts)) {
    throw new ScoutSynthesisArtifactError("Bound synthesis artifact counts changed");
  }
}

async function writeAtomicArtifact(target, content) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    const existing = await readFile(target, "utf8");
    if (existing === content) return;
    throw new ScoutSynthesisConflictError("Synthesis artifact path already has other content");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function relativeArtifactPath(taskId, synthesisId) {
  return `tasks/${taskId}/syntheses/${synthesisId}.json`;
}

export function stableStringify(value) {
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

function sortObjects(values) {
  return [...values].sort((a, b) => {
    const first = stableStringify(a);
    const second = stableStringify(b);
    return first < second ? -1 : first > second ? 1 : 0;
  });
}

function uniqueObjects(values) {
  return [...new Map(values.map((value) => [stableStringify(value), value])).values()];
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameArray(first, second) {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}
