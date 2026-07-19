import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

export class ShipMatesDashboardServer {
  constructor({
    store,
    projectContext,
    projectStore = null,
    watchdog = null,
    onCommand,
    onProjectAction = null,
    host = "127.0.0.1",
    port = 4390,
    assetsDirectory = path.resolve("src/dashboard/public"),
    listen = (app, portNumber, hostName) => app.listen(portNumber, hostName),
  } = {}) {
    if (!store || !projectContext || typeof onCommand !== "function") {
      throw new TypeError("ShipMatesDashboardServer requires store, projectContext, and onCommand");
    }
    this.store = store;
    this.projectContext = projectContext;
    this.projectStore = projectStore;
    this.watchdog = watchdog;
    this.onCommand = onCommand;
    this.onProjectAction = onProjectAction;
    this.host = host;
    this.port = port;
    this.assetsDirectory = assetsDirectory;
    this.listen = listen;
    this.server = null;
  }

  async start() {
    if (this.server) return this.url;
    const app = express();
    app.disable("x-powered-by");
    app.use(express.json({ limit: "16kb" }));
    app.use("/assets", express.static(this.assetsDirectory, { fallthrough: false }));
    app.use("/vendor/bootstrap", express.static(
      path.dirname(fileURLToPath(import.meta.resolve("bootstrap/dist/css/bootstrap.min.css"))),
      { fallthrough: false },
    ));
    app.use("/vendor/bootstrap-js", express.static(
      path.dirname(fileURLToPath(import.meta.resolve("bootstrap/dist/js/bootstrap.bundle.min.js"))),
      { fallthrough: false },
    ));
    app.get("/", (_request, response) => response.sendFile(
      path.join(this.assetsDirectory, "index.html"),
    ));
    app.get("/api/state", async (_request, response, next) => {
      try {
        response.json(await buildDashboardState({
          store: this.store,
          projectContext: this.projectContext,
          projectStore: this.projectStore,
          watchdog: this.watchdog,
        }));
      } catch (error) {
        next(error);
      }
    });
    app.get("/api/events", (request, response) => {
      response.set({
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      });
      response.flushHeaders();
      const send = async () => {
        try {
          const state = await buildDashboardState({
            store: this.store,
            projectContext: this.projectContext,
            projectStore: this.projectStore,
            watchdog: this.watchdog,
          });
          response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
        } catch {
          response.write("event: warning\ndata: {}\n\n");
        }
      };
      void send();
      const interval = setInterval(send, 1_000);
      request.once("close", () => clearInterval(interval));
    });
    app.post("/api/commands", async (request, response, next) => {
      try {
        const message = validateDashboardCommand(request.body?.message);
        setImmediate(() => Promise.resolve(this.onCommand(message)).catch(() => {}));
        response.status(202).json({ accepted: true, recipient: "Firstmate" });
      } catch (error) {
        if (error instanceof DashboardCommandError) {
          response.status(400).json({ accepted: false, error: error.message });
          return;
        }
        next(error);
      }
    });
    app.post("/api/projects/:projectId/actions", (request, response) => {
      try {
        if (typeof this.onProjectAction !== "function") {
          response.status(503).json({ accepted: false, error: "Project controls require Firstmate" });
          return;
        }
        const action = validateProjectAction({
          projectId: request.params.projectId,
          ...request.body,
        });
        setImmediate(() => Promise.resolve(this.onProjectAction(action)).catch(() => {}));
        response.status(202).json({ accepted: true, recipient: "Firstmate", action: action.action });
      } catch (error) {
        if (error instanceof DashboardCommandError) {
          response.status(400).json({ accepted: false, error: error.message });
          return;
        }
        response.status(500).json({ accepted: false, error: "Project action failed" });
      }
    });
    app.use((_error, _request, response, _next) => {
      response.status(500).json({ error: "Dashboard request failed" });
    });
    const server = this.listen(app, this.port, this.host);
    this.server = server;
    try {
      await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      this.port = server.address().port;
    } catch (error) {
      this.server = null;
      throw error;
    }
    return this.url;
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }

  get url() {
    return `http://${this.host}:${this.port}`;
  }
}

export async function buildDashboardState({
  store, projectContext, projectStore = null, watchdog = null,
}) {
  const activeProjectTaskId = await projectContext.load();
  const tasks = [];
  for (const taskId of await store.listTaskIds()) {
    try {
      tasks.push(projectTask(await store.getSnapshot(taskId), activeProjectTaskId));
    } catch {
      // A damaged historical task must not make the operator surface unavailable.
    }
  }
  tasks.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const projects = projectStore ? await projectStore.list() : [];
  const selectedProject = projectStore && typeof projectStore.active === "function"
    ? await projectStore.active() : null;
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    recipient: "Firstmate",
    activeProjectTaskId,
    activeProjectId: selectedProject?.id || null,
    watchdog: {
      thresholdMinutes: watchdog ? Math.round(watchdog.thresholdMs / 60_000) : 15,
      alerts: watchdog ? await watchdog.inspect() : [],
      historical: watchdog?.inspectHistorical ? await watchdog.inspectHistorical() : [],
    },
    projects: projects.map((project) => ({
      ...projectProjection(project, taskById), selected: project.id === selectedProject?.id,
    })),
    tasks: tasks.slice(0, 30),
  };
}

function projectProjection(project, taskById) {
  const plan = project.tasks.map((item) => {
    const execution = item.taskId ? taskById.get(item.taskId) : null;
    const status = execution?.validation?.passed === true
      ? "completed"
      : execution?.state || item.status;
    const attempts = (item.attempts || []).map((attempt) => {
      const attemptExecution = taskById.get(attempt.taskId) || null;
      return {
        ...attempt,
        current: attempt.taskId === item.taskId,
        status: attemptExecution?.state || attempt.status,
        execution: attemptExecution,
      };
    });
    return { ...item, status, execution: execution || null, attempts };
  });
  const completed = new Set(["complete", "completed"]);
  return {
    id: project.id, name: project.name, repo: project.repo, repoPath: project.repoPath,
    objective: project.objective, status: project.status, updatedAt: project.updatedAt,
    owner: project.executionPolicy?.mode === "persistent_project" ? {
      kind: "project-agent",
      name: `ShipMates Project: ${project.name}`,
      branch: project.executionPolicy.branch,
      worktreePath: project.executionPolicy.worktreePath,
    } : null,
    progress: {
      total: plan.length,
      completed: plan.filter(({ status }) => completed.has(status)).length,
      active: plan.filter(({ status }) => new Set(["claimed", "dispatched", "preparing", "running", "awaiting_worker", "validating"]).has(status)).length,
      planned: plan.filter(({ status }) => new Set(["planned", "ready"]).has(status)).length,
    },
    tasks: plan,
  };
}

function projectTask(snapshot, activeProjectTaskId) {
  const classification = snapshot.firstmateRuns?.at(-1)?.classification || null;
  const implementer = snapshot.workers?.find(({ id }) => id === "implementer") || null;
  const validation = snapshot.validationRuns?.at(-1) || null;
  return {
    id: snapshot.id,
    activeProject: snapshot.id === activeProjectTaskId,
    state: snapshot.state,
    summary: classification?.summary || implementer?.report?.summary || "ShipMates task",
    authority: classification?.requiredAuthority || "unknown",
    updatedAt: snapshot.lastEventAt,
    workspacePath: snapshot.worktree?.worktreePath || null,
    workers: (snapshot.workers || []).map((worker) => ({
      id: worker.id,
      status: worker.status,
      mode: worker.mode,
    })),
    files: (implementer?.report?.files || []).map((filename) => ({
      filename,
      path: path.join(snapshot.worktree?.worktreePath || "", filename),
      html: /\.html?$/iu.test(filename),
    })),
    validation: validation ? {
      passed: validation.passed,
      outcome: validation.outcome,
    } : null,
  };
}

export function validateDashboardCommand(value) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 4_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new DashboardCommandError("Message must be 1-4000 printable characters");
  }
  return value.trim();
}

export function validateProjectAction(value) {
  const safeId = (candidate) => typeof candidate === "string" && /^[a-z0-9][a-z0-9._-]{2,63}$/u.test(candidate);
  if (!value || !safeId(value.projectId) ||
    !new Set(["select", "approve", "pause", "resume", "dispatch_next", "priority_up", "priority_down"]).has(value.action)) {
    throw new DashboardCommandError("Invalid project action");
  }
  if (value.action.startsWith("priority_") && !safeId(value.planTaskId)) {
    throw new DashboardCommandError("Priority actions require a planned task");
  }
  return { projectId: value.projectId, action: value.action, planTaskId: value.planTaskId || null };
}

export class DashboardCommandError extends Error {
  constructor(message) {
    super(message);
    this.name = "DashboardCommandError";
  }
}
