import path from "node:path";

const artifactFollowUp =
  /\b(display|show|open|view|list|report|where|location|locations|status|result|results)\b[\s\S]*\b(file|files|page|pages|artifact|artifacts|filename|filenames|task|result|results|location|locations)\b|\bwhere\b[\s\S]*\b(file|files|page|pages|it|they)\b/iu;
const projectContinuation =
  /^(?:(?:please|can you|could you|would you|i(?:'d| would) like (?:you )?to|i want (?:you )?to)\s+)*(?:modify|change|update|revise|adjust|fix|improve|extend|add|remove|replace|rename|make)\b[\s\S]*\b(?:existing|current|previous|last|it|its|this|that|page|pages|site|website|app|program|implementation|design|layout|letters?|text|colour|color|background|button|buttons)\b/iu;

export function isFirstmateTaskFollowUp(message) {
  return typeof message === "string" && artifactFollowUp.test(message.trim());
}

export function isFirstmateProjectContinuation(message) {
  return typeof message === "string" && projectContinuation.test(message.trim());
}

export async function resolveArtifactFollowUpSnapshot({
  store, preferredTaskId = null, activeTaskIds = [],
}) {
  if (!store || typeof store.getSnapshot !== "function" ||
    typeof store.listTaskIds !== "function") {
    throw new TypeError("Artifact follow-up resolution requires a task store");
  }
  const active = new Set(activeTaskIds);
  if (preferredTaskId && active.has(preferredTaskId)) {
    return store.getSnapshot(preferredTaskId);
  }
  const ids = await store.listTaskIds();
  const snapshots = [];
  for (const taskId of ids) {
    try {
      snapshots.push(await store.getSnapshot(taskId));
    } catch {
      // One damaged historical task must not hide valid recent artifacts.
    }
  }
  snapshots.sort((left, right) =>
    Date.parse(right.lastEventAt || 0) - Date.parse(left.lastEventAt || 0));
  const preferred = snapshots.find(({ id }) => id === preferredTaskId);
  if (preferred && taskArtifactSummary(preferred).ready) return preferred;
  const activeWork = snapshots.find((snapshot) =>
    active.has(snapshot.id) && (snapshot.worktree ||
      snapshot.firstmateRuns?.at(-1)?.classification?.requiredAuthority === "local_write"));
  if (activeWork) return activeWork;
  const withArtifacts = snapshots.find((snapshot) => taskArtifactSummary(snapshot).ready);
  if (withArtifacts) return withArtifacts;
  return preferred || snapshots[0] || null;
}

export function taskArtifactSummary(snapshot) {
  const implementation = snapshot?.workers?.find(({ id }) => id === "implementer");
  const files = implementation?.report?.files || [];
  const workspacePath = snapshot?.worktree?.worktreePath || null;
  return {
    taskId: snapshot?.id || null,
    state: snapshot?.state || "unknown",
    ready: files.length > 0 && workspacePath !== null,
    files: files.map((file) => ({
      filename: file,
      path: path.join(workspacePath, file),
    })),
  };
}

export function renderTaskArtifactSummary(summary, context = {}) {
  const subject = humanTaskSubject(context);
  if (!summary.ready) {
    return summary.state === "unknown"
      ? "I could not find any files produced by recent work."
      : `${subject} is ${humanState(summary.state)}; no implementation files are ready yet.`;
  }
  return [
    `Here are the files produced by ${subject}:`,
    ...summary.files.map(({ filename, path: filePath }) => `- ${filename}: ${filePath}`),
  ].join("\n");
}

export function renderLavishReadOnlyAction(snapshot, action, context = {}) {
  if (action.taskId !== snapshot.id) throw new TypeError("Lavish action task mismatch");
  const subject = humanTaskSubject(context);
  if (action.decision === "review_files") {
    return `Selected: review the created files. ${renderTaskArtifactSummary(taskArtifactSummary(snapshot), context)}`;
  }
  if (action.decision === "review_validation") {
    const validation = snapshot.validationRuns?.at(-1);
    return validation
      ? `Selected: review validation. Validation ${validation.passed ? "passed" : "did not pass"} (${validation.outcome || "unknown outcome"}).`
      : `Selected: review validation. ${renderMissingValidation(snapshot, subject)}`;
  }
  if (action.decision === "no_action") {
    return `Selected: no further action for ${subject}. No workflow was started.`;
  }
  if (action.action === "show_files") {
    return renderTaskArtifactSummary(taskArtifactSummary(snapshot), context);
  }
  if (action.action === "show_status") {
    return `${subject} is ${humanState(snapshot.state)}.`;
  }
  if (action.action === "show_validation") {
    const validation = snapshot.validationRuns?.at(-1);
    return validation
      ? `Validation ${validation.passed ? "passed" : "did not pass"} (${validation.outcome || "unknown outcome"}).`
      : renderMissingValidation(snapshot, subject);
  }
  throw new TypeError("Unsupported Lavish action");
}

function renderMissingValidation(snapshot, subject) {
  const demoSkipped = snapshot.evidence?.some(({ kind }) =>
    kind === "demo-validation-skipped");
  return demoSkipped
    ? `${subject} completed in local-only demo mode; pipeline validation and remote operations were intentionally skipped.`
    : `${subject} has no completed validation result.`;
}

function humanTaskSubject({ taskName, projectName } = {}) {
  if (taskName && projectName) return `“${taskName}” in ${projectName}`;
  if (taskName) return `“${taskName}”`;
  if (projectName) return `the current work in ${projectName}`;
  return "the most recent work";
}

function humanState(state) {
  return String(state || "unknown").replaceAll("_", " ");
}

export function resolveLavishReviewFile(snapshot, action) {
  if (action.taskId !== snapshot.id || action.action !== "review_file" ||
    !Number.isSafeInteger(action.fileIndex) || action.fileIndex < 0) {
    throw new TypeError("Invalid Lavish review action");
  }
  const workspace = snapshot.worktree?.worktreePath;
  const files = snapshot.workers?.find(({ id }) => id === "implementer")?.report?.files || [];
  const filename = files[action.fileIndex];
  if (typeof workspace !== "string" || typeof filename !== "string" ||
    !/\.html?$/iu.test(filename)) {
    throw new TypeError("Lavish review action does not target an HTML artifact");
  }
  const root = path.resolve(workspace);
  const target = path.resolve(root, filename);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new TypeError("Lavish review artifact escapes the task worktree");
  }
  return { filename, path: target };
}
