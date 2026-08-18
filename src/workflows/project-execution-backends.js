import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { writeGovernedExecutionEnvelope } from "./governed-execution.js";

export class ProjectExecutionBackendRouter {
  constructor({ standard, persistent } = {}) {
    if (typeof standard !== "function" || typeof persistent !== "function") {
      throw new TypeError("ProjectExecutionBackendRouter requires standard and persistent backends");
    }
    this.standard = standard;
    this.persistent = persistent;
  }

  dispatch(input) {
    const mode = input.authorizedAuthority !== "read_only" &&
      input.project?.executionPolicy?.mode === "persistent_project"
      ? "persistent" : "standard";
    return this[mode](input);
  }
}

export function createFirstmateProjectExecutionBackends({
  spawnProcess,
  processPath,
  firstmateScript,
  persistentScript,
  stateRoot,
  workingDirectory,
  projectTaskRuntime,
  hasProjectPane,
  environment = process.env,
  writeEnvelope = writeGovernedExecutionEnvelope,
  appendDiagnostic = appendFirstmateDiagnostic,
} = {}) {
  if (typeof spawnProcess !== "function" || typeof hasProjectPane !== "function") {
    throw new TypeError("Firstmate execution backends require spawnProcess and hasProjectPane");
  }
  return new ProjectExecutionBackendRouter({
    persistent: ({ project, taskId, planTaskId, baseSha, instruction }) => {
      if (hasProjectPane(project.id)) {
        return projectTaskRuntime.dispatch({ project, planTaskId, taskId, baseSha, instruction });
      }
      const child = spawnProcess(processPath, [persistentScript, project.id, planTaskId, baseSha], {
        cwd: workingDirectory,
        env: { ...environment, SHIPMATES_STATE_DIR: stateRoot },
        stdio: ["pipe", "ignore", "inherit"],
      });
      child.stdin.end(`${instruction}\n`);
      return child;
    },
    standard: async ({ project, planTaskId, taskId, requestId, context, instruction, projectParent,
      validationProfile, demoMode, authorizedAuthority }) => {
      if (authorizedAuthority === "local_write" && (!project || !planTaskId)) {
        throw new Error("Governed local-write dispatch requires a project and planned task");
      }
      const envelopePath = authorizedAuthority === "local_write" && project && planTaskId
        ? await writeEnvelope({
            stateRoot,
            envelope: {
              schemaVersion: 1, projectId: project.id, planTaskId, taskId, requestId,
              repo: context.repo, baseSha: context.baseSha, instruction,
              authority: authorizedAuthority,
            },
          })
        : null;
      const child = spawnProcess(processPath, [
        firstmateScript, taskId, requestId, context.repo, context.baseSha,
      ], {
        cwd: context.repoPath,
        env: {
          ...environment,
          SHIPMATES_STATE_DIR: stateRoot,
          ...(projectParent ? { SHIPMATES_PROJECT_PARENT_TASK_ID: projectParent.id } : {}),
          SHIPMATES_VALIDATION_PROFILE: validationProfile,
          SHIPMATES_DEMO_MODE: demoMode ? "1" : "0",
          SHIPMATES_AUTHORIZED_AUTHORITY: authorizedAuthority,
          ...(envelopePath ? { SHIPMATES_GOVERNED_EXECUTION: envelopePath } : {}),
        },
        stdio: ["pipe", "ignore", "pipe"],
      });
      if (child.stderr) {
        const diagnosticsPath = envelopePath
          ? `${envelopePath}.stderr.log`
          : `${stateRoot}/tasks/${taskId}/child.stderr.log`;
        child.stderr.on("data", (chunk) => {
          child.shipmatesDiagnosticTail = `${child.shipmatesDiagnosticTail || ""}${String(chunk)}`.slice(-4096);
          const cause = sanitizedChildCause(child.shipmatesDiagnosticTail);
          if (cause) child.shipmatesFailureCause = cause;
          void appendDiagnostic(diagnosticsPath, chunk, { mode: 0o600 }).catch(() => {});
        });
      }
      child.stdin.end(`${instruction}\n`);
      return child;
    },
  });
}

export async function reconcileEarlyGovernedChildFailure({
  store, projectStore, projectId, planTaskId, taskId, exitCode, signal = null,
  cause = null, actor = "firstmate",
} = {}) {
  if (!store || !projectStore || exitCode === 0) return null;
  let snapshot = await store.getSnapshot(taskId);
  if (!new Set(["proposed", "clarified", "approved_for_dispatch", "preparing"]).has(snapshot.state) ||
    snapshot.worktree || snapshot.workers?.length > 0) return null;
  const reason = cause || (signal
    ? `Governed child exited before workspace preparation after signal ${safeToken(signal)}`
    : `Governed child exited before workspace preparation with code ${Number.isInteger(exitCode) ? exitCode : "unknown"}`);
  snapshot = await store.transition({
    taskId, from: snapshot.state, to: "blocked", actor, reason,
    eventId: `${taskId}:governed-child:preparation-blocked:v1`,
  });
  await projectStore.updateTaskStatus({
    projectId, planTaskId, status: "blocked", blockingReason: reason,
  });
  return { snapshot, reason };
}

function sanitizedChildCause(chunk) {
  const text = String(chunk ?? "");
  const matches = [...text.matchAll(/\b([A-Za-z][A-Za-z0-9]*Error):\s*([^\r\n]{1,240})/gu)];
  const match = matches.at(-1);
  const message = match?.[2].replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return match && message ? `${match[1]}: ${message}` : null;
}

function safeToken(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 32) || "unknown";
}

export async function appendFirstmateDiagnostic(filePath, chunk, options = { mode: 0o600 }) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await appendFile(filePath, chunk, options);
}
