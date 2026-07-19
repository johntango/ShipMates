import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class DashboardLavishReview {
  constructor({
    stateRoot = path.resolve(".shipmates"),
    sourceDirectory = path.resolve("src/dashboard/public"),
    bootstrapDirectory = path.resolve("node_modules/bootstrap/dist"),
  } = {}) {
    this.directory = path.join(path.resolve(stateRoot), "reviews", "dashboard");
    this.sourceDirectory = sourceDirectory;
    this.bootstrapDirectory = bootstrapDirectory;
  }

  async write() {
    await mkdir(path.join(this.directory, "assets"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.directory, "vendor"), { recursive: true, mode: 0o700 });
    const source = await readFile(path.join(this.sourceDirectory, "index.html"), "utf8");
    const html = source
      .replace('/vendor/bootstrap/bootstrap.min.css', 'vendor/bootstrap.min.css')
      .replace('/assets/dashboard.css', 'assets/dashboard.css')
      .replace('/vendor/bootstrap-js/bootstrap.bundle.min.js', 'vendor/bootstrap.bundle.min.js')
      .replace('/assets/dashboard.js', 'assets/dashboard.js')
      .replace('<script src="assets/dashboard.js"></script>',
        '<script src="assets/review-state.js"></script>\n  <script src="assets/dashboard.js"></script>');
    await Promise.all([
      copyFile(path.join(this.sourceDirectory, "dashboard.css"), path.join(this.directory, "assets", "dashboard.css")),
      copyFile(path.join(this.sourceDirectory, "dashboard.js"), path.join(this.directory, "assets", "dashboard.js")),
      copyFile(path.join(this.bootstrapDirectory, "css", "bootstrap.min.css"), path.join(this.directory, "vendor", "bootstrap.min.css")),
      copyFile(path.join(this.bootstrapDirectory, "js", "bootstrap.bundle.min.js"), path.join(this.directory, "vendor", "bootstrap.bundle.min.js")),
      writeAtomic(path.join(this.directory, "assets", "review-state.js"), renderReviewState()),
      writeAtomic(path.join(this.directory, "index.html"), html),
    ]);
    return path.join(this.directory, "index.html");
  }
}

function renderReviewState() {
  const now = new Date().toISOString();
  const tasks = [
    task("task-review-active", "Build the public website", "running", now, {
      activeProject: true,
      workers: [["scout-1", "reported", "read"], ["scout-2", "started", "read"], ["implementer", "started", "ship"]],
      files: ["index.html", "about.html"],
    }),
    task("task-review-complete", "Create the contact page", "blocked", now, {
      workers: [["scout-1", "reported", "read"], ["implementer", "reported", "ship"]],
      files: ["contact.html"], validation: { passed: true, outcome: "passed" },
    }),
    task("task-review-failed", "Improve responsive navigation", "blocked", now, {
      workers: [["implementer", "reported", "ship"]],
      files: ["navigation.html"], validation: { passed: false, outcome: "tests_failed" },
    }),
    task("task-review-stale", "Explore an alternate homepage", "recovery_required", now, {
      workers: [["scout-1", "uncertain", "read"]],
    }),
  ];
  const projects = [{
    id: "project-review", name: "ShipMates", repo: "johntango/ShipMates",
    repoPath: "/projects/ShipMates", objective: "Build a dependable multi-project coding-agent coordinator",
    status: "active", updatedAt: now,
    progress: { total: 4, completed: 1, active: 1, planned: 2 },
    tasks: [
      { id: "foundation", title: "Project registry", description: "Bind projects to repositories", status: "complete", dependsOn: [], taskId: "task-review-complete", execution: tasks[1] },
      { id: "orchestration", title: "Persistent Firstmate", description: "Coordinate work through a durable Codex thread", status: "running", dependsOn: ["foundation"], taskId: "task-review-active", execution: tasks[0] },
      { id: "dashboard", title: "Project dashboard", description: "Show plans, dependencies, and activity", status: "planned", dependsOn: ["foundation"], taskId: null, execution: null },
      { id: "github", title: "Multi-repository delivery", description: "Bind approvals to exact repository heads", status: "planned", dependsOn: ["orchestration"], taskId: null, execution: null },
    ],
  }];
  return `window.SHIPMATES_REVIEW_STATE = ${JSON.stringify({
    schemaVersion: 1, generatedAt: now, recipient: "Firstmate",
    activeProjectTaskId: "task-review-active", projects, tasks,
  })};\n`;
}

function task(id, summary, state, updatedAt, options = {}) {
  return {
    id, summary, state, updatedAt, authority: "local_write",
    activeProject: options.activeProject || false,
    workspacePath: `/treehouse/${id}`,
    workers: (options.workers || []).map(([workerId, status, mode]) => ({ id: workerId, status, mode })),
    files: (options.files || []).map((filename) => ({
      filename, path: `/treehouse/${id}/${filename}`, html: true,
    })),
    validation: options.validation || null,
  };
}

async function writeAtomic(target, contents) {
  const temporary = `${target}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}
