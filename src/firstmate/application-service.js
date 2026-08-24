import { createHash } from "node:crypto";

import { z } from "zod";

import { readWorkflowRunValidationProgress, readWorkflowRunVisibility } from "../workflow-run/adapters.js";
import {
  projectWorkflowRun, renderWorkflowRun, workflowCandidateArtifacts,
  workflowExecutionMilestones, workflowTechnicalEvidence,
} from "../workflow-run/projection.js";
import { renderValidationActivity } from "../workflow-run/progress.js";

export const FIRSTMATE_APPLICATION_SCHEMA_VERSION = 1;

const ReadIntentSchema = z.enum([
  "firstmate_status",
  "firstmate_current_design",
  "firstmate_current_plan",
  "firstmate_artifacts",
  "firstmate_technical_evidence",
]);
const ControlledIntentSchema = z.enum([
  "firstmate_approve_current_plan",
  "firstmate_approve_validation_decision",
  "firstmate_pause",
  "firstmate_cancel",
]);
const ChannelSchema = z.enum(["terminal", "dashboard", "plugin", "voice"]);

const RequestBase = z.object({
  schemaVersion: z.literal(FIRSTMATE_APPLICATION_SCHEMA_VERSION),
  channel: ChannelSchema,
  idempotencyKey: z.string().trim().regex(/^[A-Za-z0-9._:-]{8,128}$/u),
  expectedRevision: z.string().regex(/^[0-9a-f]{64}$/u).nullable().optional(),
});
const RequestSchema = z.union([
  RequestBase.extend({ intent: ReadIntentSchema }).strict(),
  RequestBase.extend({
    intent: z.literal("firstmate_answer_design_question"),
    answer: z.string().trim().min(1).max(20_000),
  }).strict(),
  RequestBase.extend({
    intent: z.literal("firstmate_propose_next_slice"),
    objective: z.string().trim().min(1).max(20_000),
  }).strict(),
  RequestBase.extend({ intent: ControlledIntentSchema }).strict(),
]);

const ApplicationRunSchema = z.object({
  phase: z.string().min(1).max(80),
  action: z.enum(["approve", "approve_validation", "status"]),
  request: z.string().max(20_000),
  plan: z.string().max(20_000),
  updatedAt: z.string().min(1).max(80),
  current: z.boolean(),
  presentation: z.object({
    outcome: z.string().min(1).max(80),
    nextAction: z.string().max(2_000).nullable(),
    why: z.string().min(1).max(4_000),
    phase: z.string().min(1).max(80),
    details: z.array(z.string().max(4_000)).max(100),
  }).strict(),
  candidate: z.object({
    workspacePath: z.string().nullable(),
    files: z.array(z.object({
      relativePath: z.string().max(2_000),
      path: z.string().max(4_000),
      html: z.boolean(),
    }).strict()).max(500),
    pageUrl: z.string().nullable(),
  }).strict(),
  milestones: z.array(z.object({
    label: z.string().max(100),
    status: z.string().max(100),
    summary: z.string().max(4_000),
  }).strict()).max(20),
  technicalEvidence: z.array(z.string().max(4_000)).max(200),
  capability: z.object({
    mode: z.string().nullable(),
    modeReason: z.string().nullable(),
    spec: z.unknown().nullable(),
    slice: z.unknown().nullable(),
    review: z.unknown().nullable(),
  }).strict().optional(),
  projectCycle: z.object({
    mode: z.string(),
    current: z.unknown(),
    currentSlice: z.unknown(),
    next: z.unknown().nullable(),
    completed: z.unknown().nullable(),
  }).strict().optional(),
}).strict();

const ResponseSchema = z.object({
  schemaVersion: z.literal(FIRSTMATE_APPLICATION_SCHEMA_VERSION),
  intent: ReadIntentSchema,
  channel: ChannelSchema,
  revision: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  confirmationRequired: z.literal(false),
  text: z.string().min(1).max(100_000),
  data: ApplicationRunSchema.nullable(),
}).strict();

export class FirstMateApplicationError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "FirstMateApplicationError";
  }
}

export function validateFirstMateApplicationRequest(value) {
  const parsed = RequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new FirstMateApplicationError("First Mate received an invalid application request", {
      cause: parsed.error,
    });
  }
  return Object.freeze(parsed.data);
}

export function validateFirstMateApplicationResponse(value) {
  const parsed = ResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new FirstMateApplicationError("First Mate produced an invalid application response", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export class FirstMateApplicationService {
  constructor({
    workflowRunStore,
    readVisibility = readWorkflowRunVisibility,
    readValidationProgress = readWorkflowRunValidationProgress,
  } = {}) {
    if (!workflowRunStore || typeof workflowRunStore.list !== "function") {
      throw new TypeError("FirstMateApplicationService requires a WorkflowRun store");
    }
    this.store = workflowRunStore;
    this.readVisibility = readVisibility;
    this.readValidationProgress = readValidationProgress;
  }

  async execute(input) {
    const request = validateFirstMateApplicationRequest(input);
    if (!ReadIntentSchema.safeParse(request.intent).success) {
      throw new FirstMateApplicationError(
        "This First Mate intent is defined but unavailable in the read-only application service",
      );
    }
    const runs = await this.#runs();
    const latest = runs[0] || null;
    const selected = request.intent === "firstmate_artifacts"
      ? runs.find(({ phase }) => phase === "completed") || latest
      : latest;
    const revision = selected ? workflowRunRevision(selected) : null;
    if (request.expectedRevision && request.expectedRevision !== revision) {
      throw new FirstMateApplicationError(
        "First Mate's durable workflow changed; refresh before using this result",
      );
    }
    const evidenceRun = selected ? await this.#runtimeEvidence(selected) : null;
    const projected = selected ? await this.project(selected, {
      current: selected === latest, evidenceRun,
    }) : null;
    const text = selected
      ? this.#text(request.intent, evidenceRun, projected, latest)
      : emptyMessage(request.intent);
    return deepFreeze(validateFirstMateApplicationResponse({
      schemaVersion: FIRSTMATE_APPLICATION_SCHEMA_VERSION,
      intent: request.intent,
      channel: request.channel,
      revision,
      confirmationRequired: false,
      text,
      data: projected,
    }));
  }

  async project(run, { current = false, evidenceRun = null } = {}) {
    const projectedRun = evidenceRun || await this.#runtimeEvidence(run);
    const presentation = projectWorkflowRun(projectedRun);
    return deepFreeze({
      phase: presentation.phase,
      action: run.phase === "awaiting_approval"
        ? "approve"
        : run.phase === "awaiting_validation_decision"
          ? "approve_validation"
          : "status",
      request: run.request,
      plan: run.plan,
      updatedAt: run.updatedAt,
      current,
      presentation,
      candidate: workflowCandidateArtifacts(run),
      milestones: workflowExecutionMilestones(projectedRun),
      technicalEvidence: workflowTechnicalEvidence(projectedRun),
      ...(run.capability ? { capability: capabilityProjection(run) } : {}),
      ...(run.projectCycle?.roadmap ? { projectCycle: projectCycleProjection(run) } : {}),
    });
  }

  async listWorkflowRuns({ historyOffset = 0, historyLimit = 10 } = {}) {
    if (!Number.isSafeInteger(historyOffset) || historyOffset < 0 ||
      !Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > 50) {
      throw new FirstMateApplicationError("Workflow history pagination is invalid");
    }
    const runs = await this.#runs();
    const history = runs.slice(1);
    const selected = runs.length ? [
      runs[0], ...history.slice(historyOffset, historyOffset + historyLimit),
    ] : [];
    return deepFreeze({
      workflowRuns: await Promise.all(selected.map((run, index) =>
        this.project(run, { current: index === 0 }))),
      workflowHistory: {
        offset: historyOffset,
        limit: historyLimit,
        total: history.length,
        nextOffset: historyOffset + Math.max(0, selected.length - 1),
        hasMore: historyOffset + Math.max(0, selected.length - 1) < history.length,
      },
    });
  }

  async #runs() {
    return [...await this.store.list()].sort((left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  async #runtimeEvidence(run) {
    if (!run.validation?.operationId || !this.store.rootDir) return run;
    const [visibility, validationActivity] = await Promise.all([
      this.readVisibility({
        stateRoot: this.store.rootDir,
        operationId: run.validation.operationId,
      }),
      this.readValidationProgress({
        stateRoot: this.store.rootDir,
        operationId: run.validation.operationId,
      }),
    ]);
    return {
      ...run,
      ...(visibility ? { visibility } : {}),
      ...(validationActivity ? {
        validationActivity,
        validationActivityMessage: renderValidationActivity(validationActivity, { visibility }),
      } : {}),
    };
  }

  #text(intent, run, projected, latest) {
    if (intent === "firstmate_current_design") {
      return renderTypedArtifact("Specification", run.capability?.spec);
    }
    if (intent === "firstmate_current_plan") return renderSelectedSlice(run.capability, run.phase);
    if (intent === "firstmate_technical_evidence") return renderWorkflowRun(run, { technical: true });
    const rendered = renderWorkflowRun(run);
    if (intent === "firstmate_artifacts" && latest && run !== latest && latest.phase === "blocked") {
      return `${rendered}\nCurrent status note: A newer workflow is blocked safely. That blocker is separate from the completed result above.`;
    }
    return rendered;
  }
}

export function workflowRunRevision(run) {
  if (!run) return null;
  return createHash("sha256").update(JSON.stringify({
    updatedAt: run.updatedAt,
    eventCount: run.eventCount || 0,
    phase: run.phase,
    runId: run.id,
  })).digest("hex");
}

export function renderTypedArtifact(label, value) {
  if (!value?.content) return `${label}: no typed artifact has been recorded.`;
  return `${label}:\n${JSON.stringify(value.content, null, 2)}\nThis is advisory evidence inside the current WorkflowRun; it grants no authority.`;
}

export function renderSelectedSlice(capability, phase) {
  const slice = capability?.slice?.content;
  const spec = capability?.spec?.content;
  if (!slice || !spec) return "Selected slice: no typed artifact has been recorded.";
  return [
    `Selected slice: ${slice.title}`,
    `Objective: ${slice.objective}`,
    `Non-goals: ${spec.nonGoals.join("; ")}`,
    `Acceptance checks: ${slice.acceptanceChecks.join("; ")}`,
    `Validation: exact candidate head; ${slice.validationPolicy.baselineAtBase ? "record base-head behavior separately" : "use the approved acceptance policy as baseline"}; no remote delivery.`,
    phase === "awaiting_approval"
      ? "Next: Reply “I approve the plan” once to authorize this bounded slice."
      : "Next: Ask for status to see the current execution evidence.",
    "Detailed typed artifact remains available in durable diagnostic evidence.",
  ].join("\n");
}

function capabilityProjection(run) {
  return {
    mode: run.capability.context?.content?.mode || null,
    modeReason: run.capability.context?.content?.modeReason || null,
    spec: clone(run.capability.spec?.content),
    slice: clone(run.capability.slice?.content),
    review: clone(run.capability.artifacts?.find(({ kind }) =>
      kind === "review.recorded")?.content),
  };
}

function projectCycleProjection(run) {
  return {
    mode: run.projectCycle.pack.name,
    current: clone(run.projectCycle.roadmap.content.currentCycle),
    currentSlice: clone(run.projectCycle.roadmap.content.nextSlice),
    next: clone(run.projectCycle.nextRoadmap?.content),
    completed: clone(run.projectCycle.completion?.content),
  };
}

function clone(value) {
  return value === undefined ? null : structuredClone(value);
}

function emptyMessage(intent) {
  if (intent === "firstmate_current_design") return "Specification: no typed artifact has been recorded.";
  if (intent === "firstmate_current_plan") return "Selected slice: no typed artifact has been recorded.";
  return "No simple local workflow has been recorded yet.";
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
