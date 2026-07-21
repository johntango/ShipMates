import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { CodexWorkerRuntime } from "../src/adapters/codex-worker.js";
import { HerdrCodexWorkerRuntime } from "../src/adapters/herdr-codex-worker.js";
import {
  HerdrExecutionObserver,
  HerdrFirstmateSession,
} from "../src/adapters/herdr-execution.js";
import { HerdrPaneClient, HerdrPanePool } from "../src/adapters/herdr-pane.js";
import { HerdrProjectAgentObserver } from "../src/adapters/herdr-project-agent.js";
import { HerdrProjectTaskRuntime } from "../src/adapters/herdr-project-task.js";
import { LavishTaskDashboard } from "../src/adapters/lavish-dashboard.js";
import { LavishSessionManager } from "../src/adapters/lavish-session.js";
import { ControlledGitCommitAdapter } from "../src/adapters/git-commit.js";
import {
  FAST_LOCAL_SKIP_STEPS,
  NoMistakesLocalGate,
} from "../src/adapters/no-mistakes.js";
import { FirstmateCodexConversation } from "../src/adapters/firstmate-codex.js";
import { TreehouseWorktreeManager } from "../src/adapters/treehouse.js";
import {
  createFirstmateId,
  discoverFirstmateContext,
} from "../src/cli/firstmate-context.js";
import { runFirstmateLoop } from "../src/cli/firstmate-loop.js";
import { FirstmateProjectContext } from "../src/cli/firstmate-project-context.js";
import {
  isFirstmateTaskFollowUp,
  isFirstmateProjectContinuation,
  renderLavishReadOnlyAction,
  renderTaskArtifactSummary,
  resolveArtifactFollowUpSnapshot,
  resolveLavishReviewFile,
  taskArtifactSummary,
} from "../src/cli/firstmate-follow-up.js";
import { readFirstmateMessage } from "../src/cli/firstmate-message.js";
import { appearsToRequireHumanInput, humanInputRequired } from "../src/cli/terminal-style.js";
import {
  answerProjectQuery,
  enrichProjectBlockers,
  isExplicitProjectPlanningRequest,
  namedActionProject,
  parseProjectBlockedCommand,
  parseProjectApproval,
  parseProjectCreation,
  parseDemoModeCommand,
  parseProjectSelection,
} from "../src/cli/firstmate-project-query.js";
import { runFirstmateDeliveryCli } from "../src/cli/firstmate-delivery.js";
import { TaskStore } from "../src/storage/task-store.js";
import { DashboardLavishReview } from "../src/dashboard/lavish-review.js";
import { ShipMatesDashboardServer } from "../src/dashboard/server.js";
import { startDashboardWithFallback } from "../src/dashboard/start.js";
import { ProjectStore } from "../src/projects/project-store.js";
import { FirstmateWatchdog } from "../src/monitoring/firstmate-watchdog.js";
import { FirstmateShell } from "../src/workflows/firstmate.js";
import { FirstmateLocalExecutor } from "../src/workflows/firstmate-local-executor.js";
import { prepareFirstmateLocalWrite } from "../src/workflows/firstmate-local-write.js";
import { CodexShipWorkflow } from "../src/workflows/codex-ship.js";
import { FirstmateCommitWorkflow } from "../src/workflows/firstmate-commit.js";
import { completeFirstmateDemoTask } from "../src/workflows/firstmate-demo-completion.js";
import { ProjectOrchestrator } from "../src/workflows/project-orchestrator.js";
import { PlannedTaskDispatcher } from "../src/workflows/planned-task-dispatch.js";
import { createFirstmateProjectExecutionBackends } from "../src/workflows/project-execution-backends.js";
import { LocalValidationWorkflow } from "../src/workflows/local-validation.js";
import { LocalDeliveryWorkflow } from "../src/workflows/local-delivery.js";
import { PersistentProjectExecutor } from "../src/workflows/persistent-project-executor.js";
import { ProjectArchiveWorkflow } from "../src/workflows/project-archive.js";
import { RepositoryDeleteWorkflow } from "../src/workflows/repository-delete.js";

const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "--delivery") {
  await runFirstmateDeliveryCli({ args: rawArgs.slice(1) });
  process.exit(0);
}
const classifyOnlyIndex = rawArgs.indexOf("--classify-only");
const classifyOnly = classifyOnlyIndex !== -1;
if (classifyOnly) rawArgs.splice(classifyOnlyIndex, 1);
const demoMode = parseBoolean("SHIPMATES_DEMO_MODE", process.env.SHIPMATES_DEMO_MODE);

if (rawArgs.length === 0 && !classifyOnly && process.stdin.isTTY) {
  await runInteractiveFirstmate();
  process.exit(0);
}

let herdrObserver = null;
let removeTerminationCleanup = () => {};
try {
let taskId;
let requestId;
let repo;
let baseSha;
let repoPath = process.cwd();
let messageParts;
if (rawArgs.length === 0) {
  const context = await discoverFirstmateContext({ cwd: repoPath });
  taskId = createFirstmateId("task");
  requestId = createFirstmateId("request");
  ({ repo, baseSha, repoPath } = context);
  messageParts = [];
  console.error(`Firstmate task: ${taskId}`);
} else if (rawArgs.length >= 4) {
  [taskId, requestId, repo, baseSha, ...messageParts] = rawArgs;
} else {
  throw new Error(
    "Usage: firstmate.js [--classify-only] [<task-id> <request-id> <owner/repo> <base-sha> [message...]]",
  );
}

const message = await readFirstmateMessage({ messageParts });

const rootDir = path.resolve(
  process.env.SHIPMATES_STATE_DIR || path.join(process.cwd(), ".shipmates"),
);
const model = process.env.SHIPMATES_FIRSTMATE_MODEL || "gpt-5.6-luna";
const tracingEnabled = parseBoolean(
  "SHIPMATES_FIRSTMATE_TRACING",
  process.env.SHIPMATES_FIRSTMATE_TRACING,
);
const store = new TaskStore({ rootDir });
herdrObserver = createHerdrObserver({ store });
removeTerminationCleanup = installTerminationCleanup(herdrObserver);
await herdrObserver?.firstmateStage({
  taskId,
  repoPath,
  message: "Classifying request",
  customStatus: "classifying",
});
const shell = new FirstmateShell({ store, model, tracingEnabled });
const result = await shell.classify({
  taskId,
  requestId,
  repo,
  baseSha,
  message,
});
const projectParentTaskId = process.env.SHIPMATES_PROJECT_PARENT_TASK_ID || null;
if (projectParentTaskId) {
  const parent = await store.getSnapshot(projectParentTaskId);
  if (parent.worktree?.headSha !== baseSha ||
    parent.worktree?.worktreePath !== repoPath) {
    throw new Error("Project revision parent does not match the supplied repository context");
  }
  await store.recordEvidence({
    taskId,
    actor: "firstmate",
    kind: "project-parent",
    value: JSON.stringify({ taskId: projectParentTaskId, headSha: baseSha }),
    eventId: `${taskId}:project-parent:v1`,
  });
}

let execution = null;
if (!classifyOnly) {
  const executionContext = await discoverFirstmateContext({ cwd: repoPath });
  if (executionContext.repo !== repo || executionContext.baseSha !== baseSha) {
    throw new Error(
      "Firstmate execution requires the current checkout to match the supplied owner/repo and base SHA; use --classify-only for detached intake",
    );
  }
  repoPath = executionContext.repoPath;
  const localRuntime = new CodexWorkerRuntime();
  const runtime = herdrObserver
    ? new HerdrCodexWorkerRuntime({
        runtime: localRuntime,
        client: herdrObserver.client,
        observer: herdrObserver,
        workerScript: fileURLToPath(
          new URL("./firstmate-pane-codex-worker.js", import.meta.url),
        ),
      })
    : localRuntime;
  const schemaPath = fileURLToPath(
    new URL("../schemas/codex-worker-report.schema.json", import.meta.url),
  );
  let implementationWorkflow = null;
  let commitWorkflow = null;
  let validationWorkflow = null;
  if (result.classification.requiredAuthority === "local_write") {
    let gate = null;
    if (!demoMode) {
      const binaryPath = process.env.NO_MISTAKES_BIN ||
        "/private/tmp/shipmates-no-mistakes-v1.37.0/no-mistakes";
      gate = new NoMistakesLocalGate({
        binaryPath,
        stateRoot: path.join(rootDir, "no-mistakes"),
        onProgress: (message) => console.error(`[no-mistakes] ${message}`),
        ...(process.env.SHIPMATES_VALIDATION_PROFILE === "fast"
          ? { skipSteps: FAST_LOCAL_SKIP_STEPS }
          : {}),
      });
      await gate.verifyPin();
    }
    const manager = new TreehouseWorktreeManager();
    const prepared = await prepareFirstmateLocalWrite({
      store,
      manager,
      taskId,
      requestId,
      repoPath,
      localOnly: demoMode,
    });
    repoPath = prepared.worktree.worktreePath;
    implementationWorkflow = new CodexShipWorkflow({
      store,
      runtime,
      worktreeManager: manager,
      schemaPath,
      actor: "firstmate",
      observer: herdrObserver,
    });
    commitWorkflow = new FirstmateCommitWorkflow({
      store,
      commitAdapter: new ControlledGitCommitAdapter(),
      actor: "firstmate",
    });
    if (gate) validationWorkflow = new LocalValidationWorkflow({ store, gate, actor: "firstmate" });
  }
  const workItemCount = result.classification.workItems?.length || 1;
  console.error(result.classification.requiresHumanApproval
    ? humanInputRequired(`Firstmate stopped at ${result.classification.approvalBoundary}. ${result.classification.recommendedNextStep}`)
    : `Firstmate is dispatching ${workItemCount} independently assigned scout${workItemCount === 1 ? "" : "s"}.`);
  const executor = new FirstmateLocalExecutor({
    runtime,
    schemaPath,
    store,
    actor: "firstmate",
    observer: herdrObserver,
    implementationWorkflow,
    scoutLimit: demoMode ? 1 : 2,
  });
  execution = await executor.execute({
    taskId,
    requestId,
    repoPath,
    message,
    classification: result.classification,
  });
  if (execution.status === "failed") {
    await herdrObserver?.firstmateStage({
      taskId,
      repoPath,
      state: "blocked",
      message: execution.failure?.message || "Local worker execution failed",
      customStatus: "worker_failed",
    });
    console.error(humanInputRequired(
      `Firstmate could not complete the local worker run: ${execution.failure?.message || "unknown worker failure"}`,
    ));
    process.exitCode = 1;
  }
  if (execution.implementation?.report.status === "completed") {
    await herdrObserver?.firstmateStage({
      taskId,
      repoPath,
      message: "Creating controlled task commit",
      customStatus: "committing",
    });
    const noChanges = execution.implementation?.verification?.noMutation === true;
    const committed = noChanges ? { commit: null } : await commitWorkflow.run({ taskId });
    if (demoMode) {
      const completed = await completeFirstmateDemoTask({ store, taskId });
      execution.delivery = {
        status: "demo_complete",
        commit: committed.commit,
        validation: { status: "skipped", mode: "local-only-demo" },
        pushTarget: null,
      };
      await herdrObserver?.firstmateStage({
        taskId, repoPath, state: "idle",
        message: "Demo task complete; no-mistakes and remote delivery skipped",
        customStatus: "demo_complete",
      });
    } else {
    await herdrObserver?.firstmateStage({
      taskId,
      repoPath,
      message: "Running pinned local validation",
      customStatus: "validating",
    });
    const validated = await validationWorkflow.run({ taskId, intent: message });
    const validationApprovalRequired =
      validated.report.gate?.status === "awaiting_approval";
    execution.delivery = {
      status: validationApprovalRequired
        ? "awaiting_validation_approval"
        : validated.report.passed ? "awaiting_push_approval" : "validation_failed",
      commit: committed.commit,
      validation: validated.report,
      pushTarget: validated.report.passed ? {
        repository: repo,
        branch: committed.commit.branch,
        headSha: committed.commit.headSha,
      } : null,
    };
    await herdrObserver?.firstmateStage({
      taskId,
      repoPath,
      state: validationApprovalRequired ? "idle" : "blocked",
      message: validationApprovalRequired
        ? `Local validation awaits human approval at ${validated.report.gate.step}`
        : validated.report.passed
          ? "Exact task commit awaits human push approval"
          : "Local validation did not pass",
      customStatus: execution.delivery.status,
    });
    if (validationApprovalRequired) {
      console.error(humanInputRequired(
        `Task ${taskId} local validation awaits human approval at ${validated.report.gate.step}. ` +
        "Review the validation details in the task dashboard before deciding how to proceed.",
      ));
    } else if (validated.report.passed) {
      console.error(humanInputRequired(
        `Task ${taskId} passed local validation and awaits explicit push approval.`,
      ));
    }
    }
  }
}
if (classifyOnly) {
  await herdrObserver?.firstmateStage({
    taskId,
    repoPath,
    state: "idle",
    message: "Classification completed",
    customStatus: "classified",
  });
}
const finalSnapshot = execution ? await store.getSnapshot(taskId) : result.snapshot;

console.log(
  JSON.stringify(
    {
      taskId,
      requestId,
      reused: result.reused,
      classification: result.classification,
      usage: result.usage,
      ledger: {
        state: finalSnapshot.state,
        eventsCount: finalSnapshot.eventsCount,
        lastEventId: finalSnapshot.lastEventId,
      },
      execution,
    },
    null,
    2,
  ),
);
removeTerminationCleanup();
} catch (error) {
  await herdrObserver?.end?.({ status: "failed" });
  removeTerminationCleanup();
  throw error;
}

function parseBoolean(name, value) {
  if (value === undefined || value === "" || value === "0" || value === "false") {
    return false;
  }
  if (value === "1" || value === "true") return true;
  throw new TypeError(`${name} must be true, false, 1, or 0`);
}

async function readExistingTaskSnapshot(store, taskId) {
  try {
    return await store.getSnapshot(taskId);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function launchReceipt(handle) {
  if (typeof handle?.paneId === "string" && handle.paneId) {
    return { kind: "pane", paneId: handle.paneId };
  }
  if (Number.isSafeInteger(handle?.pid) && handle.pid > 0) {
    return { kind: "process", pid: handle.pid };
  }
  throw new Error("Worker launch returned without an exact process or pane identity");
}

function createHerdrObserver({ store }) {
  const currentPaneId = process.env.HERDR_PANE_ID;
  if (!currentPaneId) return null;
  const client = new HerdrPaneClient();
  return new HerdrExecutionObserver({
    client,
    panePool: new HerdrPanePool({ client, store, currentPaneId }),
    currentPaneId,
    onWarning: (message) => console.error(message),
  });
}

function installTerminationCleanup(observer) {
  if (!observer) return () => {};
  const exitCodes = new Map([["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]]);
  let cleaning = false;
  const handlers = new Map();
  for (const [signal, exitCode] of exitCodes) {
    const handler = async () => {
      if (cleaning) return;
      cleaning = true;
      await observer.end({ status: "failed" });
      process.exit(exitCode);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
}

async function runInteractiveFirstmate() {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  const activeRequests = new Map();
  const advancingProjects = new Set();
  const announcedProjectCompletions = new Map();
  const pendingArtifactReports = new Set();
  const interactiveStore = new TaskStore({
    rootDir: path.resolve(
      process.env.SHIPMATES_STATE_DIR || path.join(process.cwd(), ".shipmates"),
    ),
  });
  const interactiveDashboard = new LavishTaskDashboard({
    stateRoot: interactiveStore.rootDir,
  });
  const lavishSessions = new LavishSessionManager({
    onWarning: (message) => console.error(message),
  });
  const projectContext = new FirstmateProjectContext({ store: interactiveStore });
  const projectStore = new ProjectStore({ rootDir: interactiveStore.rootDir });
  const orchestrator = new ProjectOrchestrator({
    taskStore: interactiveStore, projectStore,
  });
  const projectArchiver = new ProjectArchiveWorkflow({
    projectStore, taskStore: interactiveStore, stateRoot: interactiveStore.rootDir,
  });
  const repositoryDeleter = new RepositoryDeleteWorkflow({
    projectStore, stateRoot: interactiveStore.rootDir,
  });
  const persistentExecutor = new PersistentProjectExecutor({
    projectStore,
    runtime: new CodexWorkerRuntime(),
    schemaPath: fileURLToPath(new URL("../schemas/codex-worker-report.schema.json", import.meta.url)),
    stateRoot: interactiveStore.rootDir,
  });
  const projectAgentClient = new HerdrPaneClient();
  const firstmateHerdrSession = new HerdrFirstmateSession({
    client: projectAgentClient,
    paneId: process.env.HERDR_PANE_ID,
    onWarning: (message) => console.error(message),
  });
  const projectAgentObserver = new HerdrProjectAgentObserver({
    client: projectAgentClient,
    onWarning: (message) => console.error(message),
  });
  const projectTaskRuntime = new HerdrProjectTaskRuntime({
    client: projectAgentClient,
    observer: projectAgentObserver,
    workerScript: fileURLToPath(new URL("./project-agent-pane-worker.js", import.meta.url)),
    stateRoot: interactiveStore.rootDir,
  });
  const executionBackends = createFirstmateProjectExecutionBackends({
    spawnProcess: spawn,
    processPath: process.execPath,
    firstmateScript: fileURLToPath(import.meta.url),
    persistentScript: fileURLToPath(new URL("./persistent-project-task.js", import.meta.url)),
    stateRoot: interactiveStore.rootDir,
    workingDirectory: process.cwd(),
    projectTaskRuntime,
    hasProjectPane: (projectId) => Boolean(projectAgentObserver.paneIdFor(projectId)),
  });
  for (const project of await projectStore.list()) {
    if (project.executionPolicy?.mode !== "persistent_project") {
      try {
        const recoveredClaims = await projectStore.recoverOrphanedClaims(project.id);
        for (const task of recoveredClaims) {
          console.error(`${project.name} — ${task.title}: recovered an orphaned pre-dispatch claim.`);
        }
        const reconciled = await orchestrator.reconcileProject(project.id);
        for (const result of reconciled) {
          const task = project.tasks.find(({ id }) => id === result.planTaskId);
          console.error(`${project.name} — ${task?.title || result.planTaskId}: ${result.action} (${result.reason}).`);
        }
      } catch (error) {
        console.error(`Project reconciliation needs attention for ${project.name} (${error.message}).`);
      }
      continue;
    }
    await projectAgentObserver.ensure(project);
    for (const task of project.tasks.filter(({ status }) => new Set(["claimed", "dispatched", "blocked"]).has(status))) {
      try {
        await projectAgentObserver.stage(project, {
          state: "working", status: "reconciling", message: `${task.title}: reconciling`,
        });
        const reconciled = await persistentExecutor.reconcile({ projectId: project.id, planTaskId: task.id });
        if (reconciled?.status === "completed") {
          console.error(`Reconciled completed persistent task “${task.title}” in ${project.name}.`);
        }
        await projectAgentObserver.stage(project, {
          state: "idle",
          status: project.status === "paused" ? "paused" : "ready",
          message: project.status === "paused" ? "Project paused" : "Project ready",
        });
      } catch (error) {
        console.error(`Persistent reconciliation needs attention for ${project.name} — ${task.title} (${error.message}).`);
      }
    }
  }
  const watchdog = new FirstmateWatchdog({
    store: interactiveStore,
    projectStore,
    thresholdMs: Number(process.env.SHIPMATES_WATCHDOG_MINUTES || 15) * 60_000,
    isLiveTask: (taskId) => activeRequests.has(taskId),
  });
  const startupContext = await discoverFirstmateContext({ cwd: process.cwd() });
  await firstmateHerdrSession.start({ repoPath: startupContext.repoPath });
  const repositoryProject = await projectStore.ensureRepository({
    name: path.basename(startupContext.repoPath),
    repo: startupContext.repo,
    repoPath: startupContext.repoPath,
    baseSha: startupContext.baseSha,
  });
  let activeProject = await projectStore.active() || repositoryProject;
  const conversation = new FirstmateCodexConversation({ rootDir: interactiveStore.rootDir });
  const dashboardReview = new DashboardLavishReview({ stateRoot: interactiveStore.rootDir });
  let latestTaskId = null;
  let activeProjectTaskId = await projectContext.load();
  const humanTaskContext = async (snapshot, fallbackProjectName = null) => {
    const registered = await projectStore.describeTask(snapshot.id);
    return {
      projectName: registered?.projectName || fallbackProjectName || activeProject.name,
      taskName: registered?.taskName ||
        snapshot.firstmateRuns?.at(-1)?.classification?.summary || "Unplanned work",
    };
  };
  const handleLavishAction = async (action) => {
    const current = await interactiveStore.getSnapshot(action.taskId);
    const taskContext = await humanTaskContext(current);
    if (action.decision === "deliver_changes") {
      try {
        const delivered = await new LocalDeliveryWorkflow({
          store: interactiveStore,
        }).deliver({ taskId: action.taskId });
        await interactiveDashboard.write(delivered.snapshot);
        const subject = `“${taskContext.taskName}” in ${taskContext.projectName}`;
        const reply = delivered.reused
          ? `${subject} was already delivered at ${delivered.headSha}.`
          : `Delivered ${subject} to ${delivered.repoPath} at ${delivered.headSha}.`;
        console.log(reply);
        return reply;
      } catch (error) {
        const reply = `Delivery refused for “${taskContext.taskName}” in ${taskContext.projectName}: ${error.message}`;
        console.error(reply);
        return reply;
      }
    }
    if (action.action === "review_file") {
      const reviewFile = resolveLavishReviewFile(current, action);
      const reviewSessionId = `${action.taskId}-review-${action.fileIndex}`;
      await lavishSessions.open({
        dashboardPath: reviewFile.path,
        taskId: reviewSessionId,
        onAction: async () => "This visual review accepts annotations only.",
        onFeedback: async () => {
          const message = `Visual feedback received for ${reviewFile.filename}. Applying feedback is not enabled yet.`;
          console.log(message);
          return message;
        },
      });
      const reply = `Opened ${reviewFile.filename} in a task-bound Lavish visual review. Annotations are accepted but will not modify code yet.`;
      console.log(reply);
      return reply;
    }
    const reply = renderLavishReadOnlyAction(current, action, taskContext);
    console.log(reply);
    return reply;
  };
  const openTaskDashboard = async (snapshot, { reopen = false } = {}) => {
    const dashboardPath = await interactiveDashboard.write(snapshot);
    const context = await humanTaskContext(snapshot);
    console.error(`Lavish review for “${context.taskName}” in ${context.projectName}: ${dashboardPath}`);
    await lavishSessions.open({
      dashboardPath,
      taskId: snapshot.id,
      onAction: handleLavishAction,
      reopen,
    });
  };
  if (activeProjectTaskId) {
    try {
      await openTaskDashboard(
        await interactiveStore.getSnapshot(activeProjectTaskId),
        { reopen: true },
      );
      console.error("Firstmate reattached the prior Lavish task review.");
    } catch (error) {
      console.error(`Could not reattach the active project dashboard (${error.name}).`);
    }
  }
  const dispatchRequest = (message) => firstmateHerdrSession.withActivity({
    message: "FirstMate is handling an instruction",
    status: "coordinating",
  }, async () => {
        const selection = parseProjectSelection(message, await projectStore.list());
        if (selection) {
          if (!selection.project) {
            console.log("I could not identify the project to select. Please use its dashboard name.");
            return;
          }
          activeProject = await projectStore.activate(selection.project.id);
          console.log(`Selected ${activeProject.name} (${activeProject.repo}).`);
          if (!selection.remainder) return;
          message = selection.remainder;
        }
        const namedProject = namedActionProject(message, await projectStore.list());
        if (namedProject && namedProject.id !== activeProject.id) {
            activeProject = await projectStore.activate(namedProject.id);
            console.log(`Selected ${activeProject.name} automatically because this instruction names that project.`);
        }
        const recoverProject = message.match(/check\b[\s\S]*\b(?:processes|implementer)\b[\s\S]*\bfor\s+([a-z0-9._-]+)/iu);
        if (recoverProject) {
          const projects = await projectStore.list();
          const matches = projects.filter(({ name }) =>
            name.toLowerCase() === recoverProject[1].toLowerCase());
          if (matches.length !== 1) {
            console.log(`I could not identify one project named ${recoverProject[1]}.`);
            return;
          }
          const project = matches[0];
          const blocked = project.tasks.filter(({ status, taskId }) => status === "blocked" && taskId);
          let reconciled = 0;
          const messages = [];
          for (const planned of blocked) {
            if (activeRequests.has(planned.taskId)) {
              messages.push(`${project.name} — ${planned.title}: still running under this Firstmate process.`);
              continue;
            }
            const snapshot = await interactiveStore.getSnapshot(planned.taskId);
            const implementer = snapshot.workers?.find(({ id }) => id === "implementer");
            if (!implementer || !new Set(["dispatch_requested", "started"]).has(implementer.status)) continue;
            const workflow = new CodexShipWorkflow({
              store: interactiveStore,
              runtime: new CodexWorkerRuntime(),
              worktreeManager: new TreehouseWorktreeManager(),
              schemaPath: fileURLToPath(new URL("../schemas/codex-worker-report.schema.json", import.meta.url)),
              actor: "firstmate",
            });
            try {
              const result = await workflow.reconcile({ taskId: planned.taskId });
              if (result.worker.report.status === "completed" && result.worker.verification.noMutation) {
                await projectStore.updateTaskStatus({
                  projectId: project.id, planTaskId: planned.id, status: "completed",
                });
                reconciled += 1;
                messages.push(`${project.name} — ${planned.title}: the implementer had already finished and verified that the requested behavior exists. I reconciled its report and marked the task completed; no duplicate retry was launched.`);
              } else {
                messages.push(`${project.name} — ${planned.title}: recovered the implementer's completed artifacts. The existing changes now need commit and validation; no duplicate retry was launched.`);
              }
            } catch (error) {
              messages.push(`${project.name} — ${planned.title}: no completed implementer artifact could be safely reconciled (${error.message}). I did not launch a duplicate.`);
            }
          }
          if (messages.length === 0) {
            messages.push(`${project.name}: no blocked implementer step needs reconciliation.`);
          }
          console.log(messages.join("\n"));
          if (reconciled > 0) console.log(`Reconciled ${reconciled} completed task${reconciled === 1 ? "" : "s"} in ${project.name}.`);
          return;
        }
        const stopProject = message.match(/^(?:stop|pause)\s+(?:the\s+)?(.+?)(?:\s+project)?$/iu);
        if (stopProject) {
          const paused = await projectStore.pauseMatching(stopProject[1].trim());
          console.log(`Paused ${paused.name}; no new planned tasks will be dispatched.`);
          return;
        }
        const approveProject = parseProjectApproval(
          message, await projectStore.list(), activeProject,
        );
        if (approveProject) {
          if (!approveProject.project) {
            console.log(`I could not identify one project matching ${approveProject.query}.`);
            return;
          }
          const selected = await projectStore.activate(approveProject.project.id);
          activeProject = await projectStore.approve(selected.id);
          console.log(`Approved the ${activeProject.name} project plan.`);
          if (activeProject.executionPolicy?.autoAdvance !== false || activeProject.demoMode === true) {
            await advanceProject(activeProject.id, { reason: "project approved" });
          }
          return;
        }
        const blockProject = parseProjectBlockedCommand(message, await projectStore.list());
        if (blockProject) {
          if (!blockProject.project) {
            console.log("I could not identify one project to mark blocked.");
            return;
          }
          if (!blockProject.task) {
            console.log(blockProject.activeTaskCount === 0
              ? `${blockProject.project.name} has no claimed or dispatched task to mark blocked.`
              : `${blockProject.project.name} has ${blockProject.activeTaskCount} active tasks; identify the exact task id.`);
            return;
          }
          activeProject = await projectStore.updateTaskStatus({
            projectId: blockProject.project.id,
            planTaskId: blockProject.task.id,
            status: "blocked",
            blockingReason: blockProject.reason,
          });
          console.log(`Marked ${activeProject.name} — ${blockProject.task.title} blocked: ${blockProject.reason} No worker was dispatched.`);
          return;
        }
        const demoProject = parseDemoModeCommand(message, await projectStore.list());
        if (demoProject) {
          if (!demoProject.project) {
            console.log(`I could not identify one project matching ${demoProject.query}.`);
            return;
          }
          const selected = await projectStore.activate(demoProject.project.id);
          activeProject = await projectStore.setDemoMode({ projectId: selected.id, enabled: true });
          console.log(`Enabled local-only demo mode for ${activeProject.name}; no-mistakes and remote operations will be skipped.`);
          return;
        }
        const archiveProject = message.match(/^archive project (.+)$/iu);
        if (archiveProject) {
          const selected = await projectStore.activate(archiveProject[1].trim());
          const archived = await projectArchiver.archive({ projectId: selected.id });
          activeProject = archived.project;
          console.log(`Archived ${activeProject.name}; verified remote recovery details remain in its registry stub.`);
          return;
        }
        const protectRepository = message.match(/^protect repository (.+)$/iu);
        if (protectRepository) {
          const protectedRepository = await projectStore.setRepositoryProtected({
            query: protectRepository[1].trim(), protected: true,
          });
          console.log(`Protected ${protectedRepository.repoPath} and all ${protectedRepository.projects.length} registered project records. FirstMate will refuse repository deletion.`);
          return;
        }
        const previewRepositoryDelete = message.match(/^(?:preview delete|cleanup) repository (.+)$/iu);
        if (previewRepositoryDelete) {
          const preview = await repositoryDeleter.preview(previewRepositoryDelete[1].trim());
          const lines = [
            `Repository deletion preview for ${preview.repoPath}:`,
            `Projects: ${preview.projects.map(({ name }) => name).join(", ")}.`,
            `Status: ${preview.eligible ? "eligible" : `blocked (${preview.blockers.join("; ")})`}.`,
          ];
          if (preview.warnings.length > 0) lines.push(`Warnings: ${preview.warnings.join("; ")}.`);
          if (preview.eligible) {
            lines.push(`To move this repository to Trash and delete its ShipMates project records, enter: confirm delete repository ${preview.repoPath} ${preview.confirmationId}`);
          }
          console.log(lines.join("\n"));
          return;
        }
        const confirmRepositoryDelete = message.match(/^confirm delete repository (.+) ([a-f0-9]{16})$/iu);
        if (confirmRepositoryDelete) {
          const receipt = await repositoryDeleter.delete({
            query: confirmRepositoryDelete[1].trim(),
            confirmationId: confirmRepositoryDelete[2].toLowerCase(),
          });
          activeProject = await projectStore.active();
          console.log(`Deleted ${receipt.projects.map(({ name }) => name).join(", ")} from ShipMates and moved ${receipt.repoPath} to ${receipt.trashPath}. The GitHub repository was not changed.`);
          return;
        }
        const createProject = parseProjectCreation(message);
        if (createProject) {
          const context = await discoverFirstmateContext({ cwd: activeProject.repoPath });
          activeProject = await projectStore.create({
            name: createProject, repo: context.repo,
            repoPath: context.repoPath, baseSha: context.baseSha,
          });
          console.log(`Created and selected ${activeProject.name} in ${activeProject.repo}.`);
          return;
        }
        const addProject = message.match(/^add project\s+(.+)$/iu);
        if (addProject) {
          const context = await discoverFirstmateContext({ cwd: addProject[1].trim() });
          activeProject = await projectStore.ensureRepository({
            name: path.basename(context.repoPath), repo: context.repo,
            repoPath: context.repoPath, baseSha: context.baseSha,
          });
          activeProject = await projectStore.activate(activeProject.id);
          console.log(`Added and selected ${activeProject.name} (${activeProject.repo}) at ${activeProject.repoPath}.`);
          return;
        }
        const projectStatusRecords = await enrichProjectBlockers(
          await projectStore.list(),
          (taskId) => interactiveStore.getSnapshot(taskId),
        );
        const localProjectAnswer = answerProjectQuery(message, {
          activeProject,
          projects: projectStatusRecords,
        });
        if (localProjectAnswer !== null) {
          console.log(localProjectAnswer);
          return;
        }
        const controlIntent = await orchestrator.resolveControl(message);
        if (controlIntent?.action === "accept_demo_warning") {
          const recovered = await orchestrator.applyControl(controlIntent);
          await openTaskDashboard(recovered.snapshot, { reopen: true });
          console.log(`Applied the accepted demo warning to the existing “${controlIntent.context.taskName}” task in ${controlIntent.context.projectName}; it is complete and no worker or retry was created.`);
          return;
        }
        if (controlIntent?.action === "show_status") {
          const snapshot = await interactiveStore.getSnapshot(controlIntent.taskId);
          console.log(`“${controlIntent.context.taskName}” in ${controlIntent.context.projectName} is ${snapshot.state.replaceAll("_", " ")}.`);
          return;
        }
        if (controlIntent?.action === "show_evidence") {
          const inspected = await orchestrator.inspectTask(controlIntent.taskId);
          console.log(`${controlIntent.context.projectName} — ${controlIntent.context.taskName}: ${inspected.recovery.category}; ${inspected.recovery.reason}. Recommended action: ${inspected.recovery.action}. Last activity: ${inspected.snapshot.lastEventAt}.`);
          return;
        }
        if (controlIntent?.action === "reconcile_task") {
          const results = await orchestrator.reconcileProject(controlIntent.context.projectId);
          const result = results.find(({ planTaskId }) => planTaskId === controlIntent.context.planTaskId);
          console.log(result
            ? `${controlIntent.context.projectName} — ${controlIntent.context.taskName}: ${result.action}; ${result.reason}. No duplicate was dispatched.`
            : `${controlIntent.context.projectName} — ${controlIntent.context.taskName}: no active registry reconciliation was required.`);
          return;
        }
        if (controlIntent?.action === "mark_blocked") {
          await projectStore.updateTaskStatus({
            projectId: controlIntent.context.projectId,
            planTaskId: controlIntent.context.planTaskId,
            status: "blocked",
            blockingReason: controlIntent.reason,
          });
          console.log(`Marked ${controlIntent.context.projectName} — ${controlIntent.context.taskName} blocked: ${controlIntent.reason} No worker was dispatched.`);
          return;
        }
        if (controlIntent?.action === "retry_blocked") {
          await projectStore.resetBlockedTask({
            projectId: controlIntent.context.projectId,
            planTaskId: controlIntent.context.planTaskId,
          });
          console.log(`Reset ${controlIntent.context.projectName} — ${controlIntent.context.taskName} for an explicit new attempt; the prior task id remains in attempt history.`);
          await advanceProject(controlIntent.context.projectId, { reason: "human approved blocked-task retry" });
          return;
        }
        if (controlIntent?.action === "resume_existing") {
          const snapshot = await interactiveStore.getSnapshot(controlIntent.taskId);
          const implementer = snapshot.workers?.find(({ id }) => id === "implementer");
          const reason = implementer?.failure?.message || implementer?.failure ||
            implementer?.report?.summary || "No blocking reason was recorded.";
          console.log(`The existing “${controlIntent.context.taskName}” task in ${controlIntent.context.projectName} is ${snapshot.state.replaceAll("_", " ")}. ${reason} No duplicate was dispatched.`);
          return;
        }
        if (/\b(?:review|show|open)\b[\s\S]*\bdashboard\b[\s\S]*\blavish\b|\blavish\b[\s\S]*\bdashboard\b/iu.test(message)) {
          const reviewPath = await dashboardReview.write();
          await lavishSessions.open({
            dashboardPath: reviewPath,
            taskId: "task-dashboardreview",
            onAction: async () => "This fixture is for visual review only.",
            onFeedback: async () => {
              const reply = "Dashboard visual feedback received. Send the requested changes to Firstmate to create a new implementation task.";
              console.log(reply);
              return reply;
            },
          });
          console.log(`Opened the real Bootstrap dashboard fixture in Lavish: ${reviewPath}`);
          return;
        }
        if (isFirstmateTaskFollowUp(message)) {
          const target = await resolveArtifactFollowUpSnapshot({
            store: interactiveStore,
            preferredTaskId: activeProjectTaskId || latestTaskId,
            activeTaskIds: [...activeRequests.keys()],
          });
          const summary = taskArtifactSummary(target);
          const context = target ? await humanTaskContext(target) : {};
          console.log(renderTaskArtifactSummary(summary, context));
          if (!summary.ready && target && activeRequests.has(target.id)) {
            pendingArtifactReports.add(target.id);
            console.error("Firstmate will report the files when they are ready.");
          }
          return;
        }
        let instruction = message;
        const governedPlanDispatch = message.match(/^Implement planned task ([a-z0-9][a-z0-9._-]{2,63})\b/u);
        let planTaskId = governedPlanDispatch?.[1] || null;
        try {
          if (governedPlanDispatch) {
            const selected = (await projectStore.get(activeProject.id))?.tasks
              .find(({ id }) => id === planTaskId);
            console.log(`Firstmate is dispatching approved task “${selected?.title || "Planned work"}” in ${activeProject.name}.`);
          } else {
          const decision = await conversation.turn({
            message,
            workingDirectory: activeProject.repoPath,
            project: {
              selectedProject: activeProject,
              projects: await projectStore.list(),
            },
          });
          const renderedDecision = appearsToRequireHumanInput(decision.response)
            ? humanInputRequired(decision.response)
            : decision.response;
          if (decision.action !== "plan") console.log(renderedDecision);
          if (decision.action === "answer") return;
          if (decision.action === "control") {
            const taskContext = await projectStore.describeTask(decision.taskId);
            if (!taskContext) {
              console.error(`Firstmate could not find existing task ${decision.taskId}; no work was dispatched.`);
              return;
            }
            if (decision.controlType === "accept_demo_warning") {
              const recovered = await orchestrator.applyControl({
                action: "accept_demo_warning", taskId: decision.taskId,
              });
              await openTaskDashboard(recovered.snapshot, { reopen: true });
              console.log(`Applied the accepted demo warning to the existing “${taskContext.taskName}” task in ${taskContext.projectName}; no retry was created.`);
            } else {
              const snapshot = await interactiveStore.getSnapshot(decision.taskId);
              const implementer = snapshot.workers?.find(({ id }) => id === "implementer");
              const detail = decision.controlType === "resume_existing"
                ? implementer?.failure?.message || implementer?.failure ||
                  implementer?.report?.summary || "No blocking reason was recorded."
                : "";
              console.log(`“${taskContext.taskName}” in ${taskContext.projectName} is ${snapshot.state.replaceAll("_", " ")}.${detail ? ` ${detail} No duplicate was dispatched.` : ""}`);
            }
            return;
          }
          if (decision.action === "plan") {
            activeProject = await projectStore.savePlan({
              projectId: activeProject.id,
              objective: decision.objective,
              tasks: decision.tasks,
            });
            console.log(renderedDecision);
            console.error("Firstmate saved the project plan; review it on the dashboard before dispatching tasks.");
            return;
          }
          instruction = decision.instruction;
          planTaskId = decision.planTaskId;
          }
        } catch (error) {
          if (isExplicitProjectPlanningRequest(message)) {
            console.error(humanInputRequired(`Conversational Firstmate could not create the requested project plan (${error.name}). No task was created or dispatched. Restore planning availability and submit the planning request again.`));
            return;
          }
          console.error(`Conversational Firstmate unavailable (${error.name}); using the governed dispatcher directly.`);
        }
        // Persistent projects carry dependency continuity in their dedicated
        // branch/worktree. Completed plan items may outlive their historical
        // TaskStore ledger after cleanup, so an old events.jsonl is not needed
        // to dispatch the next planned item.
        const persistentProject = activeProject.executionPolicy?.mode === "persistent_project";
        const dependencyTaskId = !persistentProject && planTaskId
          ? await projectStore.dependencyTaskId({ projectId: activeProject.id, planTaskId })
          : null;
        let projectParent = dependencyTaskId
          ? await readExistingTaskSnapshot(interactiveStore, dependencyTaskId)
          : null;
        if (!persistentProject && !projectParent && isFirstmateProjectContinuation(instruction)) {
          projectParent = await resolveArtifactFollowUpSnapshot({
            store: interactiveStore,
            preferredTaskId: activeProjectTaskId,
            activeTaskIds: [...activeRequests.keys()],
          });
          if (projectParent && !taskArtifactSummary(projectParent).ready) {
            projectParent = null;
          }
        }
        const context = await discoverFirstmateContext({
          cwd: projectParent?.worktree?.worktreePath || activeProject.repoPath,
        });
        const taskId = createFirstmateId("task");
        const requestId = createFirstmateId("request");
        const projectIdForTask = activeProject.id;
        const projectNameForTask = activeProject.name;
        const plannedTask = planTaskId
          ? (await projectStore.get(projectIdForTask))?.tasks.find(({ id }) => id === planTaskId)
          : null;
        const projectForTask = planTaskId ? await projectStore.get(projectIdForTask) : null;
        activeProject = await projectStore.get(activeProject.id);
        if (!activeProject) {
          console.error("Firstmate refused dispatch because the selected project no longer exists.");
          return;
        }
        if (!planTaskId && activeProject.tasks.length > 0) {
          console.error("Firstmate refused to create unplanned work beside a saved project plan. Amend the plan or identify the exact planned task; no worker was dispatched.");
          return;
        }
        if (planTaskId && !plannedTask) {
          console.error(`Firstmate could not bind this instruction to planned task ${planTaskId}; no worker was dispatched.`);
          return;
        }
        if (plannedTask && !new Set(["planned", "ready", "claimed", "blocked"]).has(plannedTask.status)) {
          console.error(`“${plannedTask.title}” is already ${plannedTask.status}; Firstmate will not create a duplicate. Resume its existing task instead.`);
          return;
        }
        if (planTaskId && (activeProject.status !== "approved" || plannedTask.status !== "claimed")) {
          console.error("Firstmate refused planned-task dispatch without a durable approved plan and governed claim.");
          return;
        }
        const isTerminalMilestone = plannedTask
          ? !projectForTask.tasks.some(({ dependsOn }) => dependsOn.includes(plannedTask.id))
          : true;
        const taskName = plannedTask?.title || instruction.split(/[.!?\n]/u)[0].trim().slice(0, 120) || "Unplanned work";
        console.error(`Firstmate is starting “${taskName}” in ${projectNameForTask}.`);
        if (plannedTask && projectForTask.executionPolicy?.mode === "persistent_project") {
          await orchestrator.attachAttempt({
            projectId: projectIdForTask, taskId, title: instruction.slice(0, 160), planTaskId,
          });
          const child = await executionBackends.dispatch({
            project: projectForTask, planTaskId, taskId, requestId,
            baseSha: projectParent?.worktree?.headSha || projectForTask.baseSha,
            instruction,
          });
          await projectStore.recordLaunchReceipt({
            projectId: projectIdForTask, planTaskId, taskId,
            receipt: launchReceipt(child),
          });
          if (projectAgentObserver.paneIdFor(projectIdForTask)) {
            console.error(`${projectNameForTask} — ${taskName} is running in its Herdr Project Agent pane ${child.paneId}.`);
          }
          latestTaskId = taskId;
          activeRequests.set(taskId, child);
          child.once("error", async (error) => {
            activeRequests.delete(taskId);
            await projectStore.updateTaskStatus({
              projectId: projectIdForTask, planTaskId, status: "blocked",
              blockingReason: `${taskName} could not start (${error.name})`,
            });
            console.error(`${projectNameForTask} — ${taskName} could not start (${error.name}).`);
          });
          child.once("exit", async (exitCode) => {
            activeRequests.delete(taskId);
            if (exitCode !== 0) {
              await projectStore.updateTaskStatus({
                projectId: projectIdForTask, planTaskId, status: "blocked",
                blockingReason: `${taskName} exited with code ${exitCode}`,
              });
              console.error(humanInputRequired(`${projectNameForTask} — ${taskName} needs attention (exit ${exitCode}). Review the recorded blocker and decide whether to retry, revise, or pause.`));
            } else {
              console.error(`${projectNameForTask} — ${taskName} completed on its persistent project branch.`);
              if (projectForTask.executionPolicy?.autoAdvance !== false) {
                setImmediate(() => void advanceProject(projectIdForTask, { reason: "task completed" }));
              }
            }
          });
          console.error(`${projectNameForTask} — ${taskName} was dispatched to one Implementer with no scouts; Firstmate is listening.`);
          return;
        }
        await orchestrator.attachAttempt({
          projectId: projectIdForTask,
          taskId,
          title: instruction.slice(0, 160),
          planTaskId,
        });
        const child = executionBackends.dispatch({
          project: projectForTask,
          taskId, requestId, context, instruction, projectParent,
          validationProfile: isTerminalMilestone ? "full" : "fast",
          demoMode: projectForTask?.demoMode === true,
        });
        await projectStore.recordLaunchReceipt({
          projectId: projectIdForTask, planTaskId, taskId,
          receipt: launchReceipt(child),
        });
        latestTaskId = taskId;
        activeRequests.set(taskId, child);
        if (projectParent) {
          console.error(`“${taskName}” is continuing ${projectNameForTask} from its validated dependency.`);
        }
        child.once("error", (error) => {
          activeRequests.delete(taskId);
          console.error(`“${taskName}” in ${projectNameForTask} could not start (${error.name}).`);
        });
        child.once("exit", async (exitCode, signal) => {
          activeRequests.delete(taskId);
          console.error(exitCode === 0
            ? `“${taskName}” in ${projectNameForTask} completed.`
            : `“${taskName}” in ${projectNameForTask} failed (${signal ? `signal ${signal}` : `exit ${exitCode}`}).`);
          try {
            const snapshot = await interactiveStore.getSnapshot(taskId);
            let plannedStatus = null;
            if (planTaskId) {
              const reconciled = await orchestrator.reconcileTask(taskId);
              plannedStatus = reconciled.status === "awaiting_human"
                ? "dispatched" : reconciled.status;
            }
            if (taskArtifactSummary(snapshot).ready) {
              activeProjectTaskId = await projectContext.save(snapshot);
            }
            await openTaskDashboard(snapshot);
            if (pendingArtifactReports.delete(taskId)) {
              const summary = taskArtifactSummary(snapshot);
              console.log(renderTaskArtifactSummary(summary, { taskName, projectName: projectNameForTask }));
            }
            if (plannedStatus === "completed" &&
              (projectForTask?.demoMode === true || projectForTask?.executionPolicy?.autoAdvance !== false)) {
              setImmediate(() => void advanceProject(projectIdForTask, { reason: "task completed" }));
            }
          } catch (error) {
            console.error(`Could not create the review for “${taskName}” in ${projectNameForTask} (${error.name}).`);
          }
        });
    console.error(`“${taskName}” in ${projectNameForTask} was dispatched; Firstmate is listening for more instructions.`);
  });
  const plannedTaskDispatcher = new PlannedTaskDispatcher({
    projectStore,
    selectProject: async (projectId) => {
      activeProject = await projectStore.activate(projectId);
      return activeProject;
    },
    dispatchRequest,
  });
  const advanceProject = async (projectId, { reason = "requested" } = {}) => {
    if (advancingProjects.has(projectId)) return;
    advancingProjects.add(projectId);
    try {
      const project = await projectStore.get(projectId);
      if (!project || project.status !== "approved") return;
      const completionKey = `${project.updatedAt}:${project.tasks.map(({ id, status }) => `${id}:${status}`).join(",")}`;
      if (!project.tasks.length || !project.tasks.every(({ status }) => status === "completed")) {
        announcedProjectCompletions.delete(projectId);
      }
      if (project.tasks.some(({ status }) => new Set(["claimed", "dispatched"]).has(status))) return;
      const next = await projectStore.nextReady(projectId);
      if (!next) {
        if (project.tasks.length > 0 && project.tasks.every(({ status }) => status === "completed")) {
          if (announcedProjectCompletions.get(projectId) !== completionKey) {
            announcedProjectCompletions.set(projectId, completionKey);
            console.log(`${project.name} is complete; all planned tasks finished.`);
          }
        } else {
          console.log(`${project.name} cannot advance automatically because no task is dependency-ready.`);
        }
        return;
      }
      console.log(`${project.name}: automatically advancing to “${next.title}” (${reason}).`);
      const result = await plannedTaskDispatcher.dispatchNext({ projectId });
      if (result.status === "blocked") {
        console.error(humanInputRequired(
          `${project.name} — ${next.title} could not be dispatched: no durable task was created. The task is blocked instead of being left claimed.`,
        ));
      }
      return result.task;
    } finally {
      advancingProjects.delete(projectId);
    }
  };
  const handleProjectAction = ({ projectId, action, planTaskId }) =>
    firstmateHerdrSession.withActivity({
      message: `FirstMate is handling project action ${action}`,
      status: "coordinating",
    }, async () => {
    try {
      if (action === "select") {
        activeProject = await projectStore.activate(projectId);
        console.log(`Selected ${activeProject.name} (${activeProject.repo}) from the dashboard.`);
        return;
      }
      if (action === "approve") {
        activeProject = await projectStore.approve(projectId);
        console.log(`Approved the ${activeProject.name} project plan.`);
        if (activeProject.executionPolicy?.autoAdvance !== false) {
          await advanceProject(projectId, { reason: "plan approved" });
        }
        return;
      }
      if (action === "pause" || action === "resume") {
        activeProject = await projectStore.setPaused(projectId, action === "pause");
        console.log(`${action === "pause" ? "Paused" : "Resumed"} ${activeProject.name}.`);
        if (action === "resume" && activeProject.executionPolicy?.autoAdvance !== false) {
          await advanceProject(projectId, { reason: "project resumed" });
        }
        return;
      }
      if (action === "priority_up" || action === "priority_down") {
        activeProject = await projectStore.prioritize({
          projectId, planTaskId, direction: action === "priority_up" ? "up" : "down",
        });
        console.log(`Updated task priority in ${activeProject.name}.`);
        return;
      }
      if (action === "retry_blocked") {
        if (!planTaskId) throw new Error("Retry requires a blocked planned task");
        const result = await plannedTaskDispatcher.retryBlocked({ projectId, planTaskId });
        if (result.status !== "dispatched") {
          throw new Error("Retry returned before a durable task was created");
        }
        return { planTaskId, taskId: result.task.taskId, status: result.task.status };
      }
      return advanceProject(projectId);
    } catch (error) {
      console.error(`Project action refused: ${error.message}`);
      throw error;
    }
    });
  const dashboardServer = new ShipMatesDashboardServer({
    store: interactiveStore,
    projectContext,
    projectStore,
    watchdog,
    onCommand: dispatchRequest,
    onProjectAction: handleProjectAction,
    port: Number(process.env.SHIPMATES_DASHBOARD_PORT || 4390),
  });
  let cleanupStarted = false;
  const cleanupInteractiveFirstmate = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    terminal.close();
    await dashboardServer.stop();
    await firstmateHerdrSession.stop();
  };
  const handleTerminationSignal = (signal) => {
    void cleanupInteractiveFirstmate()
      .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  const handleSigint = () => handleTerminationSignal("SIGINT");
  const handleSigterm = () => handleTerminationSignal("SIGTERM");
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);
  try {
    const started = await startDashboardWithFallback(dashboardServer);
    console.error(`ShipMates Firstmate dashboard: ${started.url}`);
    if (started.fallback) {
      console.error(`Port ${started.requestedPort} is already in use; the command-enabled Firstmate dashboard moved to ${started.port}.`);
    }
  } catch (error) {
    console.error(`ShipMates dashboard unavailable (${error.code || error.name}: ${error.message}).`);
  }
  console.error("Firstmate ready. Enter a request, or /exit to stop.");
  const selectedBeforeAdvance = activeProject?.id;
  for (const project of await projectStore.list()) {
    if (project.status === "approved" &&
      ((project.executionPolicy?.mode === "persistent_project" &&
        project.executionPolicy.autoAdvance !== false) || project.demoMode === true)) {
      await advanceProject(project.id, { reason: "Firstmate startup" });
    }
  }
  if (selectedBeforeAdvance) activeProject = await projectStore.activate(selectedBeforeAdvance);
  try {
    const announcedWatchdogAlerts = new Set();
    const reconcileAndAdvance = async () => {
      for (const project of await projectStore.list()) {
        if (project.status !== "approved" || project.executionPolicy?.mode === "persistent_project") continue;
        const results = await orchestrator.reconcileProject(project.id);
        const progressed = results.some(({ status }) => status === "completed");
        const refreshed = await projectStore.get(project.id);
        const hasActive = refreshed.tasks.some(({ status }) =>
          new Set(["claimed", "dispatched"]).has(status));
        const ready = !hasActive ? await projectStore.nextReady(project.id) : null;
        if ((progressed || ready) && refreshed.demoMode === true) {
          await advanceProject(project.id, {
            reason: progressed ? "monitor reconciled completed work" : "monitor found ready work",
          });
        }
      }
    };
    const auditWatchdog = async () => {
      try {
        await reconcileAndAdvance();
      } catch (error) {
        console.error(`Proactive project reconciliation needs attention (${error.message}).`);
      }
      try {
        for (const terminalized of await watchdog.terminalizeStale()) {
          console.error(humanInputRequired(`Watchdog blocked stale task ${terminalized.projectName} — ${terminalized.taskName}. ${terminalized.reason}`));
        }
      } catch (error) {
        console.error(`Watchdog stale-task terminalization needs attention (${error.message}).`);
      }
      for (const alert of await watchdog.inspect()) {
        const key = `${alert.taskId}:${alert.category}:${alert.lastEventAt}`;
        if (announcedWatchdogAlerts.has(key)) continue;
        announcedWatchdogAlerts.add(key);
        console.error(humanInputRequired(`Watchdog: ${alert.projectName} — ${alert.taskName} has needed attention for ${alert.ageMinutes} minutes. ${alert.status}. ${alert.remedy}`));
      }
    };
    await auditWatchdog();
    const monitorIntervalMs = Math.max(5, Number(process.env.SHIPMATES_MONITOR_SECONDS || 15)) * 1_000;
    const watchdogInterval = setInterval(() => void auditWatchdog(), monitorIntervalMs);
    await runFirstmateLoop({
      askMessage: (prompt) => terminal.question(prompt),
      runRequest: dispatchRequest,
    });
    clearInterval(watchdogInterval);
  } finally {
    process.removeListener("SIGINT", handleSigint);
    process.removeListener("SIGTERM", handleSigterm);
    await cleanupInteractiveFirstmate();
  }
  console.error(activeRequests.size === 0
    ? "Firstmate stopped."
    : `Firstmate stopped listening; ${activeRequests.size} dispatched task${activeRequests.size === 1 ? "" : "s"} still running.`);
}
