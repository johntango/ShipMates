import { createHash } from "node:crypto";

import { WorkflowRunError } from "./reducer.js";

export class WorkflowRunController {
  constructor({ store, worker, validator } = {}) {
    if (!store || !worker || !validator) throw new TypeError("WorkflowRunController requires store, worker, and validator");
    this.store = store;
    this.worker = worker;
    this.validator = validator;
  }

  async approve(runId) {
    await this.store.append(runId, "workflow.approved", {}, "approved");
    return this.advance(runId);
  }

  async advance(runId) {
    try {
      return await this.#advance(runId);
    } catch (error) {
      const run = await this.store.get(runId);
      if (new Set(["completed", "blocked"]).has(run.phase)) return run;
      return this.#block(run, safeReason(error));
    }
  }

  async #advance(runId) {
    for (let step = 0; step < 8; step += 1) {
      let run = await this.store.get(runId);
      if (new Set(["awaiting_approval", "completed", "blocked"]).has(run.phase)) return run;
      if (run.phase === "approved") {
        const operationId = operation(run.id, "worker");
        await this.store.append(run.id, "worker.launch_requested", { operationId }, "worker-launch-requested");
        continue;
      }
      if (run.phase === "launching") {
        const result = await recoverOrStart(this.worker, "launch", run.worker.operationId, {
          operationId: run.worker.operationId, run,
        });
        if (!result) return this.#block(run, "Worker launch could not be proven after interruption");
        await this.store.append(run.id, "worker.launched", {
          operationId: run.worker.operationId, receipt: result.receipt,
        }, "worker-launched");
        if (result.completed) await this.#recordWorker(run.id, run.worker.operationId, result.completed);
        continue;
      }
      if (run.phase === "implementing") {
        const result = await this.worker.observe({ operationId: run.worker.operationId, receipt: run.worker.receipt, run });
        if (!result?.completed) return run;
        await this.#recordWorker(run.id, run.worker.operationId, result.completed);
        continue;
      }
      if (run.phase === "worker_complete") {
        const operationId = operation(run.id, `validation:${run.worker.headSha}`);
        await this.store.append(run.id, "validation.requested", {
          operationId, headSha: run.worker.headSha, intent: run.plan,
        }, "validation-requested");
        continue;
      }
      if (run.phase === "validating") {
        const result = await recoverOrStart(this.validator, "start", run.validation.operationId, {
          operationId: run.validation.operationId,
          workspacePath: run.worker.workspacePath,
          headSha: run.validation.headSha,
          intent: run.validation.intent,
          run,
        });
        if (!result) return this.#block(run, "Validation result could not be proven after interruption");
        if (!new Set(["passed", "failed"]).has(result.status)) return run;
        if (result.headSha !== run.validation.headSha) return this.#block(run, "Validator reported a different Git head");
        await this.store.append(run.id, "validation.observed", {
          operationId: run.validation.operationId, status: result.status,
          headSha: result.headSha, report: result.report,
        }, "validation-observed");
        continue;
      }
      if (run.phase === "validated") {
        await this.store.append(run.id, "workflow.completed", {}, "completed");
        continue;
      }
      throw new WorkflowRunError(`Controller cannot advance phase ${run.phase}`);
    }
    throw new WorkflowRunError("WorkflowRun exceeded its bounded transition budget");
  }

  async #recordWorker(runId, operationId, completed) {
    await this.store.append(runId, "worker.completed", {
      operationId, workspacePath: completed.workspacePath,
      headSha: completed.headSha, report: completed.report,
    }, "worker-completed");
  }

  async #block(run, reason) {
    return this.store.append(run.id, "workflow.blocked", { reason }, `blocked:${operation(run.id, reason)}`);
  }
}

async function recoverOrStart(adapter, method, operationId, input) {
  const observed = await adapter.observe({ ...input, operationId });
  if (observed) return observed;
  return adapter[method](input);
}

function operation(runId, purpose) {
  return createHash("sha256").update(`${runId}:${purpose}`).digest("hex").slice(0, 24);
}

function safeReason(error) {
  const name = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name)
    ? error.name : "WorkflowError";
  return `Workflow stopped before another side effect (${name})`;
}
