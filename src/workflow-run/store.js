import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { reduceWorkflowRun, WorkflowRunError } from "./reducer.js";

export class WorkflowRunStore {
  constructor({ rootDir, clock = () => new Date(), idFactory = randomUUID, onEvent = null } = {}) {
    if (!rootDir) throw new TypeError("WorkflowRunStore requires rootDir");
    this.rootDir = path.resolve(rootDir);
    this.clock = clock;
    this.idFactory = idFactory;
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
  }

  async create({ request, plan, repoPath, baseHeadSha, authority = "local_write", capabilityBundle = null }) {
    const runId = `workflow-${this.idFactory()}`;
    const event = this.event(runId, "workflow.created", {
      request, plan, repoPath: path.resolve(repoPath), baseHeadSha, authority,
    }, "created");
    const events = [event];
    if (capabilityBundle) {
      events.push(
        this.event(runId, "capability.selected", { pack: capabilityBundle.pack }, "capability-selected"),
        this.event(runId, "context.captured", { artifact: capabilityBundle.context }, `artifact:${capabilityBundle.context.digest}`),
        this.event(runId, "spec.proposed", { artifact: capabilityBundle.spec }, `artifact:${capabilityBundle.spec.digest}`),
        this.event(runId, "slice.selected", { artifact: capabilityBundle.slice }, `artifact:${capabilityBundle.slice.digest}`),
      );
      if (capabilityBundle.projectCycle) events.push(
        this.event(runId, "project_cycle.selected", { pack: capabilityBundle.projectCycle.pack }, "project-cycle-selected"),
        this.event(runId, "roadmap.proposed", { artifact: capabilityBundle.projectCycle.roadmap }, `artifact:${capabilityBundle.projectCycle.roadmap.digest}`),
      );
    }
    await this.#write(runId, events, { exclusive: true });
    const run = reduceWorkflowRun(events);
    for (const created of events) await this.#notify(created, run);
    return run;
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
      const run = reduceWorkflowRun(next);
      await this.#notify(event, run);
      return run;
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

  async archiveRuns({ runIds, archiveName, manifest }) {
    if (!Array.isArray(runIds) || !runIds.length ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{2,120}$/u.test(archiveName)) {
      throw new WorkflowRunError("Invalid WorkflowRun archive request");
    }
    const archiveRoot = path.join(this.rootDir, "workflow-archives", archiveName);
    await mkdir(path.join(archiveRoot, "runs"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(archiveRoot, "operations"), { recursive: true, mode: 0o700 });
    const manifestPath = path.join(archiveRoot, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx", mode: 0o600,
    }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    for (const runId of runIds) {
      const run = await this.get(runId);
      await moveIfPresent(
        path.join(this.rootDir, "workflow-runs", runId),
        path.join(archiveRoot, "runs", runId),
      );
      for (const operationId of [run.worker?.operationId, run.validation?.operationId].filter(Boolean)) {
        await moveIfPresent(
          path.join(this.rootDir, "workflow-run-operations", operationId),
          path.join(archiveRoot, "operations", operationId),
        );
      }
    }
    return Object.freeze({ archiveRoot, manifestPath });
  }

  event(runId, type, data, key = this.idFactory()) {
    return { id: `${runId}:${key}`, runId, type, at: this.clock().toISOString(), data };
  }

  async #notify(event, run) {
    try { await this.onEvent?.(event, run); }
    catch { /* Progress visibility must never affect durable workflow state. */ }
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

async function moveIfPresent(source, destination) {
  try { await rename(source, destination); }
  catch (error) {
    if (error.code === "ENOENT") return;
    if (error.code === "EEXIST") return;
    throw error;
  }
}
