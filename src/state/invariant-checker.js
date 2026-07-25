import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { inspectProjectInvariants } from "../projects/project-invariants.js";
import { HerdrProjection } from "../projections/herdr.js";
import { STATE_CONTRACT } from "./state-contract.js";

export class StateInvariantChecker {
  constructor({ rootDir, projectStore, taskStore, herdrProjection, read = readFile, limit = 500 } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.projectStore = projectStore;
    this.taskStore = taskStore;
    this.herdrProjection = herdrProjection;
    this.read = read;
    this.limit = limit;
  }

  async inspect() {
    const findings = [];
    const rawRegistry = await this.#readJson("projects.json", { allowMissing: true });
    if (rawRegistry) {
      checkSchema(rawRegistry.schemaVersion, STATE_CONTRACT.projectRegistry.schemaVersion,
        "project_registry", findings);
      checkFields(rawRegistry, STATE_CONTRACT.projectRegistry.documentFields,
        "project_registry", findings);
      inspectRawProjects(rawRegistry.projects, findings, this.limit);
    }
    let projects = [];
    try {
      projects = await this.projectStore.list({ includeArchived: true });
    } catch (error) {
      findings.push(issue("project_registry_unreadable", "project_registry", error.message));
    }
    const attemptOwners = new Map();
    for (const project of projects.slice(0, this.limit)) {
      checkFields(project, STATE_CONTRACT.projectRegistry.projectFields, `project:${project.id}`, findings);
      for (const invariant of inspectProjectInvariants(project)) {
        findings.push(issue(invariant.code, `project:${project.id}:${invariant.subject}`, "Project registry invariant failed."));
      }
      if (project.status === "completed" && !project.tasks.every(({ status }) => status === "completed")) {
        findings.push(issue("project_completed_with_incomplete_task", `project:${project.id}`, "Completed Project contains non-completed plan work."));
      }
      for (const task of project.tasks) {
        checkFields(task, STATE_CONTRACT.projectRegistry.taskFields, `plan_task:${project.id}:${task.id}`, findings);
        for (const attempt of task.attempts) {
          checkFields(attempt, STATE_CONTRACT.projectRegistry.attemptFields, `attempt:${attempt.taskId}`, findings);
          const prior = attemptOwners.get(attempt.taskId);
          if (prior) findings.push(issue("attempt_owned_by_multiple_projects", `attempt:${attempt.taskId}`, `Also owned by ${prior}.`));
          else attemptOwners.set(attempt.taskId, `${project.id}:${task.id}`);
        }
      }
    }

    const taskIds = (await this.taskStore.listTaskIds()).slice(0, this.limit);
    for (const taskId of taskIds) await this.#inspectTask(taskId, findings);
    await this.#inspectActivePointer(findings);
    return {
      schemaVersion: STATE_CONTRACT.schemaVersion,
      readOnly: true,
      clean: findings.length === 0,
      summary: { projects: projects.length, ledgers: taskIds.length, findings: findings.length,
        truncated: projects.length > this.limit || (await this.taskStore.listTaskIds()).length > this.limit },
      findings: findings.slice(0, this.limit),
    };
  }

  async #inspectTask(taskId, findings) {
    let events;
    let snapshot;
    try {
      events = await this.taskStore.readEvents(taskId);
      snapshot = await this.taskStore.getSnapshot(taskId);
    } catch (error) {
      findings.push(issue("task_ledger_unreadable", `task:${taskId}`, error.message));
      return;
    }
    for (const [index, event] of events.entries()) {
      checkFields(event, STATE_CONTRACT.taskLedger.eventEnvelopeFields, `task:${taskId}:event:${index}`, findings);
      if (!STATE_CONTRACT.taskLedger.eventTypes.includes(event.type)) {
        findings.push(issue("unknown_task_event", `task:${taskId}:event:${event.id}`, event.type));
      } else {
        checkFields(event.data, STATE_CONTRACT.taskLedger.eventPayloadFields[event.type],
          `task:${taskId}:event:${index}:data`, findings);
      }
    }
    checkSchema(snapshot.schemaVersion, STATE_CONTRACT.taskLedger.snapshotSchemaVersion, `task:${taskId}:snapshot`, findings);
    checkFields(snapshot, STATE_CONTRACT.taskLedger.snapshotFields, `task:${taskId}:snapshot`, findings);
    let persisted;
    try {
      persisted = await this.#readJson(path.join("tasks", taskId, "snapshot.json"), { allowMissing: true });
    } catch (error) {
      findings.push(issue("snapshot_corrupt", `task:${taskId}:snapshot`, error.message));
    }
    if (!persisted) findings.push(issue("snapshot_missing", `task:${taskId}`, "Derived snapshot can be rebuilt from events.jsonl."));
    else if (!isDeepStrictEqual(persisted, snapshot)) {
      findings.push(issue("snapshot_stale_or_corrupt", `task:${taskId}`, "Persisted snapshot differs from authoritative event replay."));
    }
    let herdr;
    try {
      const projection = this.herdrProjection || new HerdrProjection({ store: this.taskStore });
      herdr = await projection.read({ taskId });
    } catch (error) {
      findings.push(issue("herdr_projection_unreadable", `task:${taskId}`, error.message));
    }
    if (herdr && (herdr.source?.lastEventId !== snapshot.lastEventId ||
      herdr.source?.eventsCount !== snapshot.eventsCount)) {
      findings.push(issue("herdr_projection_watermark_mismatch", `task:${taskId}`, "Herdr projection does not identify its ledger watermark."));
    }
  }

  async #inspectActivePointer(findings) {
    const pointer = await this.#readJson("active-project.json", { allowMissing: true });
    if (!pointer) return;
    checkSchema(pointer.schemaVersion, STATE_CONTRACT.activePointer.schemaVersion, "active_pointer", findings);
    checkFields(pointer, STATE_CONTRACT.activePointer.fields, "active_pointer", findings);
    try {
      const snapshot = await this.taskStore.getSnapshot(pointer.taskId);
      if (snapshot.state === "complete") {
        findings.push(issue("completed_task_active_pointer", `task:${pointer.taskId}`, "Active pointer is a stale projection and must derive to null."));
      }
    } catch (error) {
      findings.push(issue("active_pointer_target_unreadable", "active_pointer", error.message));
    }
  }

  async #readJson(relative, { allowMissing = false } = {}) {
    try { return JSON.parse(await this.read(path.join(this.rootDir, relative), "utf8")); }
    catch (error) {
      if (allowMissing && error.code === "ENOENT") return null;
      throw error;
    }
  }
}

function checkSchema(actual, expected, target, findings) {
  if (actual !== expected) findings.push(issue("unsupported_schema_version", target, `Expected ${expected}, observed ${actual}.`));
}

function checkFields(value, documented, target, findings) {
  for (const field of Object.keys(value || {})) {
    if (!documented.includes(field)) findings.push(issue("undocumented_persisted_field", `${target}.${field}`, "Field is absent from the state contract."));
  }
}

function inspectRawProjects(projects, findings, limit) {
  for (const project of Array.isArray(projects) ? projects.slice(0, limit) : []) {
    checkFields(project, STATE_CONTRACT.projectRegistry.projectFields, `project:${project.id}`, findings);
    if (project.executionPolicy) checkFields(project.executionPolicy,
      STATE_CONTRACT.projectRegistry.executionPolicyFields, `project:${project.id}:execution_policy`, findings);
    for (const task of Array.isArray(project.tasks) ? project.tasks : []) {
      checkFields(task, STATE_CONTRACT.projectRegistry.taskFields, `plan_task:${project.id}:${task.id}`, findings);
      for (const attempt of Array.isArray(task.attempts) ? task.attempts : []) {
        checkFields(attempt, STATE_CONTRACT.projectRegistry.attemptFields,
          `attempt:${attempt.taskId}`, findings);
        if (attempt.launchReceipt) checkFields(attempt.launchReceipt,
          STATE_CONTRACT.projectRegistry.launchReceiptFields,
          `attempt:${attempt.taskId}:launch_receipt`, findings);
      }
    }
  }
}

function issue(code, target, message) { return { code, target, message }; }
