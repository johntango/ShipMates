import { createHash, randomUUID } from "node:crypto";

import { Agent, run } from "@openai/agents";
import { z } from "zod";

import { validateTaskId } from "../core/task-state.js";

const identifier = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/u);

export const firstmateInputSchema = z
  .object({
    taskId: identifier,
    requestId: identifier,
    repo: z.string().trim().min(1),
    baseSha: z.string().trim().min(1),
    message: z.string().trim().min(1).max(20_000),
  })
  .strict();

export const firstmateOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    summary: z.string().trim().min(1).max(2_000),
    taskType: z.enum([
      "answer",
      "review",
      "diagnosis",
      "code_change",
      "external_operation",
    ]),
    requiredAuthority: z.enum([
      "read_only",
      "local_write",
      "external_write",
      "destructive",
    ]),
    approvalBoundary: z.enum([
      "none",
      "before_external_write",
      "before_destructive_action",
    ]),
    recommendedNextStep: z.string().trim().min(1).max(2_000),
    requiresHumanApproval: z.boolean(),
    workItems: z.array(z.string().trim().min(1).max(2_000)).min(1).max(2),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedBoundary = {
      read_only: "none",
      local_write: "none",
      external_write: "before_external_write",
      destructive: "before_destructive_action",
    }[value.requiredAuthority];
    if (value.approvalBoundary !== expectedBoundary) {
      context.addIssue({
        code: "custom",
        path: ["approvalBoundary"],
        message: "approval boundary must match required authority",
      });
    }
    if (value.requiresHumanApproval !== (expectedBoundary !== "none")) {
      context.addIssue({
        code: "custom",
        path: ["requiresHumanApproval"],
        message: "human approval flag must match required authority",
      });
    }
  });

const instructions = `You are Firstmate, the sole conversational owner for ShipMates.
Classify one user request and do not claim work without matching evidence.
Choose the minimum authority required for the requested outcome:
- read_only: answer, inspect, explain, diagnose, or review without changes
- local_write: edit or build only in the authorized local workspace
- external_write: publish, push, comment, open a PR, send, deploy, or mutate a remote system
- destructive: delete, discard, overwrite, merge, or otherwise perform an irreversible action
Classify the requested outcome, not the internal work needed to produce it. ShipMates
can launch its own local read-only scouts after classification; launching those scouts,
running local tools or subprocesses, and returning their findings or generated values
to the user are read_only operations, not external writes. Tool availability does not
change the authority classification and must not be mentioned as a reason to escalate.
Return one or two non-overlapping workItems. Each work item must be independently
assignable to exactly one Codex scout. Split separable requested outputs into distinct
items; never send the same work to multiple scouts. Scouts are read-only: never make
"implement the change" a scout work item, because the separate Implementer owns all
local writes. Use one scout for an indivisible code change unless two genuinely distinct
read-only investigations are required before implementation.
External-write and destructive requests require human approval at the matching boundary.
Return only the structured classification.`;

export function createFirstmateAgent({ model = "gpt-5.6-luna", tools = [] } = {}) {
  if (!Array.isArray(tools)) throw new TypeError("tools must be an array");
  return new Agent({
    name: "Firstmate",
    instructions:
      tools.length === 0
        ? `${instructions}\nYou have no tools and must not claim to have performed work.`
        : `${instructions}\nYou may call only the explicitly supplied bounded tools. A tool result is evidence for your classification; it does not transfer conversational ownership.`,
    model,
    modelSettings: {
      reasoning: { effort: "none" },
      maxTokens: 512,
      store: false,
      parallelToolCalls: false,
    },
    tools,
    handoffs: [],
    outputType: firstmateOutputSchema,
  });
}

export class FirstmateShell {
  constructor({
    store,
    actor = "firstmate",
    model = "gpt-5.6-luna",
    tracingEnabled = false,
    runAgent = run,
    agent = createFirstmateAgent({ model }),
    attemptIdFactory = randomUUID,
  }) {
    if (!store) throw new TypeError("store is required");
    this.store = store;
    this.actor = actor;
    this.model = model;
    this.tracingEnabled = tracingEnabled;
    this.runAgent = runAgent;
    this.agent = agent;
    this.attemptIdFactory = attemptIdFactory;
  }

  async classify(input) {
    const parsed = firstmateInputSchema.parse(input);
    validateTaskId(parsed.taskId);
    let snapshot = await this.#ensureTask(parsed);
    const existing = snapshot.firstmateRuns.find(
      ({ requestId }) => requestId === parsed.requestId,
    );

    if (existing) {
      this.#verifyExistingRequest(existing, parsed.message);
      if (existing.status === "classified") {
        snapshot = await this.#ensureClarified(snapshot, parsed.requestId);
        return {
          classification: existing.classification,
          usage: existing.usage,
          snapshot,
          reused: true,
        };
      }
      if (existing.status === "requested") {
        throw new FirstmateRunUncertainError(
          `Firstmate request ${parsed.requestId} has durable intent but no result; reconcile before retrying`,
        );
      }
      throw new FirstmateShellError(
        `Firstmate request ${parsed.requestId} previously failed; use a new request ID after review`,
      );
    }

    const requestSha256 = digest(parsed.message);
    const attemptId = this.attemptIdFactory();
    const requestEventId = `firstmate-${parsed.requestId}-requested`;
    snapshot = await this.store.requestFirstmateRun({
      taskId: parsed.taskId,
      actor: this.actor,
      requestId: parsed.requestId,
      attemptId,
      requestSha256,
      model: this.model,
      maxTurns: 1,
      tracingEnabled: this.tracingEnabled,
      storeResponse: false,
      eventId: requestEventId,
    });

    let classification;
    let usage;
    try {
      const result = await this.runAgent(
        this.agent,
        buildModelInput(parsed),
        {
          maxTurns: 1,
          tracingDisabled: !this.tracingEnabled,
          traceIncludeSensitiveData: false,
          workflowName: "ShipMates Firstmate intake",
          groupId: parsed.taskId,
        },
      );
      classification = firstmateOutputSchema.parse(result.finalOutput);
      usage = normalizeUsage(result.state?.usage);
    } catch (cause) {
      await this.store.recordFirstmateFailure({
        taskId: parsed.taskId,
        actor: this.actor,
        requestId: parsed.requestId,
        requestEventId,
        category: errorCategory(cause),
        message: "Agents SDK run failed before a classification was recorded",
        eventId: `firstmate-${parsed.requestId}-failed`,
      });
      throw new FirstmateShellError(
        `Firstmate could not classify request ${parsed.requestId}`,
        { cause },
      );
    }

    snapshot = await this.store.recordFirstmateClassification({
      taskId: parsed.taskId,
      actor: this.actor,
      requestId: parsed.requestId,
      requestEventId,
      classification,
      usage,
      eventId: `firstmate-${parsed.requestId}-classified`,
    });
    snapshot = await this.#ensureClarified(snapshot, parsed.requestId);
    return { classification, usage, snapshot, reused: false };
  }

  async #ensureTask(input) {
    let events;
    try {
      events = await this.store.readEvents(input.taskId);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      events = [];
    }
    if (events.length === 0) {
      return this.store.createTask({
        taskId: input.taskId,
        kind: "firstmate-intake",
        repo: input.repo,
        baseSha: input.baseSha,
        actor: this.actor,
        eventId: `firstmate-${input.requestId}-task-created`,
      });
    }
    const snapshot = await this.store.getSnapshot(input.taskId);
    if (
      snapshot.kind !== "firstmate-intake" ||
      snapshot.repo !== input.repo ||
      snapshot.baseSha !== input.baseSha
    ) {
      throw new FirstmateShellError(
        `Task ${input.taskId} does not match this Firstmate intake`,
      );
    }
    return snapshot;
  }

  #verifyExistingRequest(existing, message) {
    if (existing.requestSha256 !== digest(message)) {
      throw new FirstmateShellError(
        `Request ID ${existing.requestId} was reused with different input`,
      );
    }
  }

  async #ensureClarified(snapshot, requestId) {
    if (snapshot.state !== "proposed") return snapshot;
    return this.store.transition({
      taskId: snapshot.id,
      from: "proposed",
      to: "clarified",
      reason: "Firstmate recorded a typed request classification",
      actor: this.actor,
      eventId: `firstmate-${requestId}-clarified`,
    });
  }
}

export class FirstmateShellError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "FirstmateShellError";
  }
}

export class FirstmateRunUncertainError extends FirstmateShellError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "FirstmateRunUncertainError";
  }
}

function buildModelInput(input) {
  return [
    `Task ID: ${input.taskId}`,
    `Request ID: ${input.requestId}`,
    "User request:",
    input.message,
  ].join("\n");
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeUsage(usage) {
  const normalized = {
    requests: usage?.requests ?? 0,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
  };
  for (const [field, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Invalid Agents SDK usage field ${field}`);
    }
  }
  return normalized;
}

function errorCategory(error) {
  const name = error?.name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9]*$/u.test(name)
    ? name
    : "UnknownError";
}
