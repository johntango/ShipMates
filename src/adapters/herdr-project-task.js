import { EventEmitter } from "node:events";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export class HerdrProjectTaskRuntime {
  constructor({
    client, observer, workerScript, stateRoot, nodePath = process.execPath,
    pollMs = 250, timeoutMs = 3_600_000,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    if (!client || !observer || !workerScript || !stateRoot) {
      throw new TypeError("HerdrProjectTaskRuntime requires client, observer, workerScript, and stateRoot");
    }
    this.client = client;
    this.observer = observer;
    this.workerScript = path.resolve(workerScript);
    this.stateRoot = path.resolve(stateRoot);
    this.nodePath = nodePath;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.delay = delay;
  }

  async dispatch({ project, planTaskId, taskId, baseSha, instruction }) {
    const paneId = this.observer.paneIdFor(project.id) || await this.observer.ensure(project);
    if (!paneId) throw new Error(`No Herdr Project Agent pane is available for ${project.name}`);
    const directory = path.join(this.stateRoot, "project-agent-jobs", project.id, planTaskId);
    const jobPath = path.join(directory, "job.json");
    const terminalPath = path.join(directory, "terminal.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await unlink(terminalPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await writeFile(jobPath, `${JSON.stringify({
      schemaVersion: 1, projectId: project.id, projectName: project.name,
      planTaskId, taskId, baseSha, instruction,
      stateRoot: this.stateRoot, terminalPath,
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const handle = new EventEmitter();
    handle.paneId = paneId;
    await this.client.run({
      paneId,
      command: [this.nodePath, this.workerScript, jobPath].map(shellQuote).join(" "),
    });
    void this.#monitor({ handle, terminalPath, project, planTaskId, taskId });
    return handle;
  }

  async #monitor({ handle, terminalPath, project, planTaskId, taskId }) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() <= deadline) {
      try {
        const marker = JSON.parse(await readFile(terminalPath, "utf8"));
        validateMarker(marker, { projectId: project.id, planTaskId, taskId });
        handle.emit("exit", marker.exitCode, marker.signal || null);
        return;
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
          handle.emit("error", error);
          return;
        }
      }
      await this.delay(this.pollMs);
    }
    handle.emit("error", new Error(`${project.name} Project Agent timed out without a terminal marker`));
  }
}

function validateMarker(marker, expected) {
  if (!marker || marker.schemaVersion !== 1 || marker.projectId !== expected.projectId ||
    marker.planTaskId !== expected.planTaskId || marker.taskId !== expected.taskId ||
    !Number.isInteger(marker.exitCode) || Number.isNaN(Date.parse(marker.completedAt))) {
    throw new Error("Project Agent terminal marker is invalid");
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}
