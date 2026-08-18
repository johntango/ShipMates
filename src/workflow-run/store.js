import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { reduceWorkflowRun, WorkflowRunError } from "./reducer.js";

export class WorkflowRunStore {
  constructor({ rootDir, clock = () => new Date(), idFactory = randomUUID } = {}) {
    if (!rootDir) throw new TypeError("WorkflowRunStore requires rootDir");
    this.rootDir = path.resolve(rootDir);
    this.clock = clock;
    this.idFactory = idFactory;
  }

  async create({ request, plan, repoPath, baseHeadSha, authority = "local_write" }) {
    const runId = `workflow-${this.idFactory()}`;
    const event = this.event(runId, "workflow.created", {
      request, plan, repoPath: path.resolve(repoPath), baseHeadSha, authority,
    }, "created");
    await this.#write(runId, [event], { exclusive: true });
    return reduceWorkflowRun([event]);
  }

  async append(runId, type, data, key) {
    return this.#withLock(runId, async () => {
      const events = await this.events(runId);
      const event = this.event(runId, type, data, key);
      const existing = events.find(({ id }) => id === event.id);
      if (existing) return reduceWorkflowRun(events);
      const next = [...events, event];
      reduceWorkflowRun(next);
      await this.#write(runId, next);
      return reduceWorkflowRun(next);
    });
  }

  async get(runId) { return reduceWorkflowRun(await this.events(runId)); }

  async list() {
    let entries;
    try { entries = await readdir(path.join(this.rootDir, "workflow-runs"), { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const runs = [];
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      try { runs.push(await this.get(entry.name)); } catch { /* Ignore damaged historical runs. */ }
    }
    return runs.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  async events(runId) {
    try {
      const value = JSON.parse(await readFile(this.#file(runId), "utf8"));
      if (!Array.isArray(value)) throw new Error("not an array");
      return value;
    } catch (cause) {
      if (cause?.code === "ENOENT") throw new WorkflowRunError(`Unknown WorkflowRun: ${runId}`);
      if (cause instanceof WorkflowRunError) throw cause;
      throw new WorkflowRunError(`Could not read WorkflowRun: ${runId}`, { cause });
    }
  }

  event(runId, type, data, key = this.idFactory()) {
    return { id: `${runId}:${key}`, runId, type, at: this.clock().toISOString(), data };
  }

  async #write(runId, events, { exclusive = false } = {}) {
    const directory = path.dirname(this.#file(runId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (exclusive) {
      const handle = await open(this.#file(runId), "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(events, null, 2)}\n`); } finally { await handle.close(); }
      return;
    }
    const temporary = `${this.#file(runId)}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(events, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.#file(runId));
  }

  async #withLock(runId, operation) {
    const lock = `${this.#file(runId)}.lock`;
    await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
    let handle;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { handle = await open(lock, "wx", 0o600); break; }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!handle) throw new WorkflowRunError(`WorkflowRun is busy: ${runId}`);
    try { return await operation(); }
    finally { await handle.close(); await unlink(lock).catch(() => {}); }
  }

  #file(runId) {
    if (!/^workflow-[A-Za-z0-9_-]+$/u.test(runId)) throw new WorkflowRunError("Invalid WorkflowRun id");
    return path.join(this.rootDir, "workflow-runs", runId, "events.json");
  }
}
