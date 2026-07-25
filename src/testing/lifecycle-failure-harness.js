import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ProjectStore } from "../projects/project-store.js";
import { DurableOperationProtocol } from "../operations/durable-operation.js";
import { TaskStore } from "../storage/task-store.js";

const execFileAsync = promisify(execFile);
export const LIFECYCLE_OPERATIONS = Object.freeze([
  "register", "plan", "approve_plan", "dispatch", "report", "commit",
  "validate", "approve_validation", "deliver", "complete",
]);
export const TERMINATION_PHASES = Object.freeze([
  "before_intent", "after_intent", "before_action", "after_action",
  "before_receipt", "after_receipt",
]);
export const LIFECYCLE_ACTIONS = Object.freeze([
  "dispatch.clone", "report.artifact", "commit.git", "validate.artifact",
  "approve_validation.artifact", "deliver.fetch", "deliver.merge",
]);

export class InjectedLifecycleTermination extends Error {
  constructor(point) { super(`Injected lifecycle termination at ${point}`); this.point = point; }
}

export class LifecycleFailureHarness {
  constructor({ stateRoot, destinationRepo, sourceRepo, inject = () => {}, run = runCommand } = {}) {
    this.stateRoot = path.resolve(stateRoot);
    this.destinationRepo = path.resolve(destinationRepo);
    this.sourceRepo = path.resolve(sourceRepo);
    this.inject = inject;
    this.run = run;
    this.projectStore = new ProjectStore({ rootDir: this.stateRoot });
    this.taskStore = new TaskStore({ rootDir: this.stateRoot });
    this.journalPath = path.join(this.stateRoot, "lifecycle-harness.json");
    this.artifactRoot = path.join(this.stateRoot, "external-observations");
    this.taskId = "harness-task";
    this.planTaskId = "harness-plan";
    this.operationProtocol = new DurableOperationProtocol({
      journal: this.#actionJournal(), hook: (point) => this.inject(point),
    });
  }

  async resume() {
    for (const operation of LIFECYCLE_OPERATIONS) {
      await this.#operation(operation, () => this.#observe(operation), () => this.#act(operation));
    }
    return this.inspect();
  }

  async inspect() {
    const [journal, projects, snapshot, destinationHead, sourceHead] = await Promise.all([
      this.#journal(), this.projectStore.list({ includeArchived: true }),
      this.taskStore.getSnapshot(this.taskId), this.#git(this.destinationRepo, ["rev-parse", "HEAD"]),
      this.#git(this.sourceRepo, ["rev-parse", "HEAD"]),
    ]);
    const project = projects.find(({ name }) => name === "Harness Project");
    return {
      completed: project?.status === "completed" && snapshot.state === "complete",
      operations: journal.operations,
      actions: journal.actions,
      project,
      snapshot,
      destinationHead: destinationHead.trim(),
      sourceHead: sourceHead.trim(),
      validatedHead: (await this.#artifactObservation("validation.json")).evidence?.headSha || null,
      counts: {
        attempts: project?.tasks[0]?.attempts.length || 0,
        workerArtifacts: this.#attemptCount(journal, "report.artifact"),
        commits: this.#attemptCount(journal, "commit.git"),
        validationRuns: this.#attemptCount(journal, "validate.artifact"),
        approvals: this.#attemptCount(journal, "approve_validation.artifact"),
        deliveries: this.#attemptCount(journal, "deliver.merge"),
      },
    };
  }

  async #operation(name, observe, act) {
    let journal = await this.#journal();
    const actionNames = LIFECYCLE_ACTIONS.filter((action) => action.startsWith(`${name}.`));
    const actionsComplete = actionNames.every((action) => journal.actions?.[action]?.receipt);
    if (journal.operations[name]?.receipt && actionsComplete) return;
    if (!journal.operations[name]?.intent) {
      this.#terminate(name, "before_intent");
      journal.operations[name] = { intent: { id: `${name}:v1`, at: new Date().toISOString() }, receipt: null };
      await this.#writeJournal(journal);
      this.#terminate(name, "after_intent");
    }
    let observation = await observe();
    if (!observation.completed || !actionsComplete) {
      this.#terminate(name, "before_action");
      await act();
      this.#terminate(name, "after_action");
      observation = await observe();
      if (!observation.completed) throw new Error(`${name} action is not independently observable`);
    }
    this.#terminate(name, "before_receipt");
    journal = await this.#journal();
    journal.operations[name].receipt = { observedAt: new Date().toISOString(), evidence: observation.evidence };
    await this.#writeJournal(journal);
    this.#terminate(name, "after_receipt");
  }

  async #action(operation, action, intent, observe, act) {
    const name = `${operation}.${action}`;
    await this.operationProtocol.execute({
      operationId: name, intent: { id: `${name}:v1`, ...intent }, observe, act,
    });
  }

  async #observe(name) {
    const projects = await this.projectStore.list({ includeArchived: true });
    const project = projects.find(({ name }) => name === "Harness Project");
    const planTask = project?.tasks.find(({ id }) => id === this.planTaskId);
    if (name === "register") return observed(Boolean(project), { projectId: project?.id });
    if (name === "plan") return observed(Boolean(planTask), { planTaskId: planTask?.id });
    if (name === "approve_plan") return observed(project?.status === "approved", { status: project?.status });
    if (name === "dispatch") {
      const snapshot = await this.#snapshot();
      return observed(Boolean(planTask?.attempts.some(({ taskId }) => taskId === this.taskId) && snapshot && await exists(this.sourceRepo)),
        { taskId: this.taskId });
    }
    if (name === "report") return this.#artifactObservation("worker-report.json");
    if (name === "commit") {
      const head = await this.#git(this.sourceRepo, ["rev-parse", "HEAD"]);
      const count = Number((await this.#git(this.sourceRepo, ["rev-list", "--count", "HEAD"])).trim());
      const snapshot = await this.#snapshot();
      return observed(count === 2 && snapshot?.state === "validating", { headSha: head.trim() });
    }
    if (name === "validate") return this.#artifactObservation("validation.json");
    if (name === "approve_validation") return this.#artifactObservation("approval.json");
    if (name === "deliver") {
      const destination = (await this.#git(this.destinationRepo, ["rev-parse", "HEAD"])).trim();
      const validation = await this.#artifactObservation("validation.json");
      return observed(destination === validation.evidence?.headSha, { headSha: destination });
    }
    if (name === "complete") {
      const snapshot = await this.#snapshot();
      return observed(project?.status === "completed" && snapshot?.state === "complete",
        { projectStatus: project?.status, taskState: snapshot?.state });
    }
    throw new Error(`Unknown lifecycle operation ${name}`);
  }

  async #act(name) {
    const project = (await this.projectStore.list({ includeArchived: true }))
      .find(({ name }) => name === "Harness Project");
    if (name === "register") {
      const head = (await this.#git(this.destinationRepo, ["rev-parse", "HEAD"])).trim();
      await this.projectStore.create({ name: "Harness Project", repo: "local/harness", repoPath: this.destinationRepo, baseSha: head });
    } else if (name === "plan") {
      await this.projectStore.savePlan({ projectId: project.id, objective: "Exercise lifecycle recovery", tasks: [
        { id: this.planTaskId, title: "Lifecycle work", description: "Create one exact commit", dependsOn: [] },
      ] });
    } else if (name === "approve_plan") {
      await this.projectStore.approve(project.id);
    } else if (name === "dispatch") {
      const head = project.baseSha;
      await this.#action(name, "clone", {
        sourceRepo: this.destinationRepo, destinationRepo: this.sourceRepo, headSha: head,
      }, async () => {
        if (!await exists(this.sourceRepo)) return observed(false, null);
        const clonedHead = (await this.#git(this.sourceRepo, ["rev-parse", "HEAD"])).trim();
        const origin = (await this.#git(this.sourceRepo, ["remote", "get-url", "origin"])).trim();
        return observed(clonedHead === head && path.resolve(origin) === this.destinationRepo,
          { sourceRepo: this.destinationRepo, destinationRepo: this.sourceRepo, headSha: clonedHead });
      },
        () => this.run("git", ["clone", "--quiet", this.destinationRepo, this.sourceRepo]));
      await this.#git(this.sourceRepo, ["config", "user.name", "ShipMates Harness"]);
      await this.#git(this.sourceRepo, ["config", "user.email", "harness@shipmates.local"]);
      await this.projectStore.claimReadyTask({ projectId: project.id, planTaskId: this.planTaskId });
      await this.projectStore.attachTask({ projectId: project.id, planTaskId: this.planTaskId, taskId: this.taskId, title: "Lifecycle work" });
      await this.taskStore.createTask({ taskId: this.taskId, kind: "lifecycle-harness", repo: "local/harness", baseSha: project.baseSha, actor: "harness", eventId: "harness:create" });
      await this.#transitionPath(["clarified", "approved_for_dispatch", "preparing", "running"]);
    } else if (name === "report") {
      const work = "durable lifecycle work\n";
      const artifact = { taskId: this.taskId, files: ["work.txt"], status: "completed" };
      await writeFile(path.join(this.sourceRepo, "work.txt"), work);
      await this.#action(name, "artifact", { name: "worker-report.json", value: artifact },
        () => this.#exactArtifactObservation("worker-report.json", artifact),
        () => this.#writeArtifact("worker-report.json", artifact));
      await this.taskStore.recordEvidence({ taskId: this.taskId, actor: "harness", kind: "worker-report", value: "worker-report.json", eventId: "harness:report" });
    } else if (name === "commit") {
      const parentSha = project.baseSha;
      const message = "Harness lifecycle commit";
      const content = "durable lifecycle work\n";
      await this.#git(this.sourceRepo, ["add", "work.txt"]);
      await this.#action(name, "git", {
        repo: this.sourceRepo, parentSha, message, files: { "work.txt": content },
      }, async () => {
        const head = (await this.#git(this.sourceRepo, ["rev-parse", "HEAD"])).trim();
        if (head === parentSha) return observed(false, { headSha: head });
        const parent = (await this.#git(this.sourceRepo, ["rev-parse", "HEAD^"])).trim();
        const subject = (await this.#git(this.sourceRepo, ["show", "-s", "--format=%s", "HEAD"])).trim();
        const committed = await this.#git(this.sourceRepo, ["show", "HEAD:work.txt"]);
        return observed(parent === parentSha && subject === message && committed === content,
          { headSha: head, parentSha: parent, message: subject, files: { "work.txt": committed } });
      }, () => this.#git(this.sourceRepo, ["commit", "--quiet", "-m", message]));
      const head = (await this.#git(this.sourceRepo, ["rev-parse", "HEAD"])).trim();
      await this.taskStore.recordEvidence({ taskId: this.taskId, actor: "harness", kind: "git-commit", value: head, eventId: "harness:commit" });
      await this.#transitionPath(["validating"]);
    } else if (name === "validate") {
      const head = (await this.#git(this.sourceRepo, ["rev-parse", "HEAD"])).trim();
      const artifact = { taskId: this.taskId, headSha: head, passed: true };
      await this.#action(name, "artifact", { name: "validation.json", value: artifact },
        () => this.#exactArtifactObservation("validation.json", artifact),
        () => this.#writeArtifact("validation.json", artifact));
      await this.taskStore.recordEvidence({ taskId: this.taskId, actor: "harness", kind: "validation", value: head, eventId: "harness:validation" });
    } else if (name === "approve_validation") {
      const validation = (await this.#artifactObservation("validation.json")).evidence;
      const head = validation.headSha;
      const artifact = { taskId: this.taskId, headSha: head, decision: "approved" };
      await this.#action(name, "artifact", { name: "approval.json", value: artifact },
        () => this.#exactArtifactObservation("approval.json", artifact),
        () => this.#writeArtifact("approval.json", artifact));
      await this.taskStore.recordEvidence({ taskId: this.taskId, actor: "human", kind: "validation-approval", value: head, eventId: "harness:approval" });
    } else if (name === "deliver") {
      const head = (await this.#artifactObservation("validation.json")).evidence.headSha;
      await this.#action(name, "fetch", {
        destinationRepo: this.destinationRepo, sourceRepo: this.sourceRepo, headSha: head,
      }, async () => {
        try {
          const fetched = (await this.#git(this.destinationRepo, ["rev-parse", "FETCH_HEAD"])).trim();
          return observed(fetched === head, { headSha: fetched });
        } catch {
          return observed(false, null);
        }
      }, () => this.#git(this.destinationRepo, ["fetch", "--quiet", this.sourceRepo, head]));
      await this.#action(name, "merge", {
        destinationRepo: this.destinationRepo, headSha: head, mode: "ff-only",
      }, async () => {
        const destination = (await this.#git(this.destinationRepo, ["rev-parse", "HEAD"])).trim();
        return observed(destination === head, { headSha: destination });
      }, () => this.#git(this.destinationRepo, ["merge", "--ff-only", head]));
      await this.taskStore.recordEvidence({ taskId: this.taskId, actor: "harness", kind: "local-delivery", value: head, eventId: "harness:delivery" });
    } else if (name === "complete") {
      await this.#transitionPath(["cleaning", "complete"]);
      await this.projectStore.updateTaskStatus({ projectId: project.id, planTaskId: this.planTaskId, status: "completed" });
    }
  }

  async #transitionPath(states) {
    let snapshot = await this.taskStore.getSnapshot(this.taskId);
    for (const to of states) {
      snapshot = await this.taskStore.transition({ taskId: this.taskId, from: snapshot.state, to,
        actor: "harness", eventId: `harness:to:${to}` });
    }
  }

  async #snapshot() { try { return await this.taskStore.getSnapshot(this.taskId); } catch { return null; } }
  async #artifactObservation(name) {
    try { return observed(true, JSON.parse(await readFile(path.join(this.artifactRoot, name), "utf8"))); }
    catch (error) { if (error.code === "ENOENT") return observed(false, null); throw error; }
  }
  async #exactArtifactObservation(name, expected) {
    const observation = await this.#artifactObservation(name);
    return observed(observation.completed &&
      stableJson(observation.evidence) === stableJson(expected), observation.evidence);
  }
  #attemptCount(journal, name) { return journal.actions?.[name]?.attempts?.length || 0; }
  async #writeArtifact(name, value) { await mkdir(this.artifactRoot, { recursive: true }); await writeFile(path.join(this.artifactRoot, name), `${JSON.stringify(value)}\n`); }
  async #journal() {
    try { return JSON.parse(await readFile(this.journalPath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return { schemaVersion: 1, operations: {} }; throw error; }
  }
  async #writeJournal(value) {
    await mkdir(this.stateRoot, { recursive: true });
    const temporary = `${this.journalPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, this.journalPath);
  }
  #actionJournal() {
    const update = async (name, transform) => {
      const journal = await this.#journal();
      journal.actions ||= {};
      const current = journal.actions[name] || { operationId: name, intent: null, attempts: [], receipt: null };
      journal.actions[name] = transform(current);
      await this.#writeJournal(journal);
      return journal.actions[name];
    };
    return {
      read: async (name) => (await this.#journal()).actions?.[name] || null,
      recordIntent: (name, intent) => update(name, (current) => ({ ...current, intent })),
      recordAttempt: (name, attempt) => update(name, (current) => ({
        ...current, attempts: [...(current.attempts || []), attempt],
      })),
      recordReceipt: (name, receipt) => update(name, (current) => ({ ...current, receipt })),
    };
  }
  async #git(cwd, args) { const { stdout = "" } = await this.run("git", args, { cwd }); return stdout; }
  #terminate(operation, phase) { this.inject(`${operation}:${phase}`); }
}

function observed(completed, evidence) { return { completed, evidence }; }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function exists(target) { try { await readFile(path.join(target, ".git", "HEAD")); return true; } catch { return false; } }
async function runCommand(command, args, options = {}) { return execFileAsync(command, args, { encoding: "utf8", ...options }); }
