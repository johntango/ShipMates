export class DurableOperationProtocol {
  constructor({ journal, hook = () => {}, clock = () => new Date() } = {}) {
    if (!journal || typeof journal.read !== "function" ||
      typeof journal.recordIntent !== "function" ||
      typeof journal.recordAttempt !== "function" ||
      typeof journal.recordReceipt !== "function") {
      throw new TypeError("DurableOperationProtocol requires an atomic operation journal");
    }
    this.journal = journal;
    this.hook = hook;
    this.clock = clock;
  }

  async execute({ operationId, intent, observe, act } = {}) {
    if (typeof operationId !== "string" || operationId === "" ||
      !intent || typeof observe !== "function" || typeof act !== "function") {
      throw new TypeError("Durable operation requires operationId, intent, observe, and act");
    }
    let operation = await this.journal.read(operationId);
    if (operation?.receipt) return completed(operation, true);

    let observation = normalizeObservation(await observe(intent));
    if (!operation?.intent) {
      await this.#phase(operationId, "before_intent");
      operation = await this.journal.recordIntent(operationId, {
        ...intent, recordedAt: this.clock().toISOString(),
      });
      await this.#phase(operationId, "after_intent");
    } else {
      assertSameIntent(operation.intent, intent, operationId);
    }

    if (!observation.completed) {
      await this.#phase(operationId, "before_action");
      operation = await this.journal.recordAttempt(operationId, {
        attempt: (operation.attempts?.length || 0) + 1,
        recordedAt: this.clock().toISOString(),
      });
      await act(intent);
      await this.#phase(operationId, "after_action");
      observation = normalizeObservation(await observe(intent));
      if (!observation.completed) {
        throw new DurableOperationError(`${operationId} is not independently observable after action`);
      }
    }

    await this.#phase(operationId, "before_receipt");
    operation = await this.journal.recordReceipt(operationId, {
      observedAt: this.clock().toISOString(), evidence: observation.evidence,
    });
    await this.#phase(operationId, "after_receipt");
    return completed(operation, false);
  }

  async #phase(operationId, phase) { await this.hook(`${operationId}:${phase}`); }
}

export class DurableOperationError extends Error {}

function normalizeObservation(value) {
  if (!value || typeof value.completed !== "boolean") {
    throw new DurableOperationError("Operation observation must contain boolean completed");
  }
  return { completed: value.completed, evidence: value.evidence ?? null };
}

function assertSameIntent(recorded, supplied, operationId) {
  const { recordedAt: _recordedAt, ...durable } = recorded;
  if (stableJson(durable) !== stableJson(supplied)) {
    throw new DurableOperationError(`${operationId} cannot be reused with different intent`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function completed(operation, reused) {
  return { operationId: operation.operationId, receipt: operation.receipt, reused };
}
