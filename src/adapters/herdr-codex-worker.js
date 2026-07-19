import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const terminalFile = "firstmate-pane-terminal.json";
const jobFile = "firstmate-pane-job.json";

export class HerdrCodexWorkerRuntime {
  constructor({
    runtime,
    client,
    observer,
    workerScript,
    nodePath = process.execPath,
    timeoutMs = 3_600_000,
    pollMs = 100,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    if (!runtime || !client || !observer || !workerScript) {
      throw new TypeError(
        "HerdrCodexWorkerRuntime requires runtime, client, observer, and workerScript",
      );
    }
    this.runtime = runtime;
    this.client = client;
    this.observer = observer;
    this.workerScript = path.resolve(workerScript);
    this.nodePath = nodePath;
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
    this.delay = delay;
    this.backend = "codex-cli-herdr";
  }

  async run(input) {
    const paneId = this.observer.paneIdFor?.(input.workerId) || null;
    if (!paneId) return this.runtime.run(input);
    const artifactDirectory = path.resolve(input.artifactDirectory);
    await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
    const jobPath = path.join(artifactDirectory, jobFile);
    const terminalPath = path.join(artifactDirectory, terminalFile);
    await Promise.all([jobPath, terminalPath].map((target) =>
      unlink(target).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      })));
    await writeFile(jobPath, `${JSON.stringify({
      schemaVersion: 1,
      taskId: input.taskId,
      workerId: input.workerId,
      paneId,
      workingDirectory: path.resolve(input.workingDirectory),
      prompt: input.prompt,
      schemaPath: path.resolve(input.schemaPath),
      artifactDirectory,
      sandbox: input.sandbox,
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await this.client.run({
      paneId,
      command: [this.nodePath, this.workerScript, jobPath].map(shellQuote).join(" "),
    });
    const marker = await this.#waitForTerminal({ terminalPath, paneId, input });
    if (marker.status !== "completed") {
      throw new HerdrCodexWorkerProcessError(
        `Pane Codex worker ${input.workerId} failed (${marker.errorName})`,
        { definitive: true },
      );
    }
    const completed = await this.runtime.loadCompleted({
      taskId: input.taskId,
      artifactDirectory,
    });
    if (typeof input.onEvent === "function") {
      await replayEvents(completed.artifacts.events, input.onEvent);
    }
    return completed;
  }

  loadCompleted(input) {
    return this.runtime.loadCompleted(input);
  }

  async #waitForTerminal({ terminalPath, paneId, input }) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() <= deadline) {
      try {
        const marker = JSON.parse(await readFile(terminalPath, "utf8"));
        validateMarker(marker, { paneId, taskId: input.taskId, workerId: input.workerId });
        return marker;
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      await this.delay(this.pollMs);
    }
    throw new HerdrCodexWorkerProcessError(
      `Timed out waiting for pane Codex worker ${input.workerId}`,
      { definitive: false },
    );
  }
}

export class HerdrCodexWorkerProcessError extends Error {
  constructor(message, { definitive = false } = {}) {
    super(message);
    this.name = "HerdrCodexWorkerProcessError";
    this.definitive = definitive;
  }
}

export async function writePaneTerminalMarker(directory, value) {
  const target = path.join(path.resolve(directory), terminalFile);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, target);
}

function validateMarker(marker, expected) {
  if (
    !marker || marker.schemaVersion !== 1 || marker.taskId !== expected.taskId ||
    marker.workerId !== expected.workerId || marker.paneId !== expected.paneId ||
    !new Set(["completed", "failed"]).has(marker.status) ||
    (marker.status === "failed" && !marker.errorName) ||
    Number.isNaN(Date.parse(marker.completedAt))
  ) throw new HerdrCodexWorkerProcessError("Pane Codex terminal marker is invalid");
}

async function replayEvents(eventsPath, onEvent) {
  const contents = await readFile(eventsPath, "utf8");
  for (const line of contents.split(/\r?\n/u).filter(Boolean)) {
    try {
      await onEvent(JSON.parse(line));
    } catch {
      // Visibility remains best-effort; the validated artifacts are authoritative.
    }
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}
