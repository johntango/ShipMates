import { createHash } from "node:crypto";

import { z } from "zod";

export const PROJECT_CYCLE_SCHEMA_VERSION = 1;

const SliceSchema = z.object({
  title: z.string().min(1), objective: z.string().min(1),
  acceptanceChecks: z.array(z.string().min(1)).min(1).max(12),
}).strict();

const CyclePackSchema = z.object({
  schemaVersion: z.literal(PROJECT_CYCLE_SCHEMA_VERSION),
  name: z.enum(["greenfield", "brownfield"]), version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  defaults: z.object({ currentCycle: z.string().min(1), whyNow: z.string().min(1) }).strict(),
}).strict();

const RoadmapSchema = z.object({
  schemaVersion: z.literal(PROJECT_CYCLE_SCHEMA_VERSION),
  mode: z.enum(["greenfield", "brownfield"]),
  currentCycle: z.object({
    name: z.string().min(1), whyNow: z.string().min(1),
    architectureAssumptions: z.array(z.string().min(1)).max(12),
    adrRefs: z.array(z.string().min(1)).max(12),
    exitCriteria: z.array(z.string().min(1)).min(1).max(12),
    risksAndDependencies: z.array(z.string().min(1)).max(12),
  }).strict(),
  nextSlice: SliceSchema,
}).strict();

const CompletionSchema = z.object({
  schemaVersion: z.literal(PROJECT_CYCLE_SCHEMA_VERSION),
  outcome: z.literal("passed"), changedFiles: z.array(z.string()).max(100),
  validationSummary: z.string().min(1),
}).strict();

const PACKS = Object.freeze({
  greenfield: cyclePack("greenfield", {
    currentCycle: "Walking skeleton",
    whyNow: "A minimal end-to-end experience proves the architecture before security, datastore, or scale work.",
  }),
  brownfield: cyclePack("brownfield", {
    currentCycle: "Characterize and change safely",
    whyNow: "Repository context and existing behavior must be understood before extending the system.",
  }),
});

export function projectCyclePack(mode) {
  const selected = PACKS[mode];
  if (!selected) throw new TypeError(`Unknown project cycle mode: ${mode}`);
  return selected;
}

export function verifyProjectCyclePack(value) {
  const { digest: suppliedDigest, ...content } = value || {};
  const parsed = CyclePackSchema.parse(content);
  const expected = projectCyclePack(parsed.name);
  if (suppliedDigest !== expected.digest || JSON.stringify(parsed) !== JSON.stringify({
    schemaVersion: expected.schemaVersion, name: expected.name, version: expected.version,
    defaults: expected.defaults,
  })) {
    throw new TypeError("Project cycle pack digest does not match its schema content");
  }
  return expected;
}

export function prepareProjectCycle({ mode, request, context, slice }) {
  const pack = projectCyclePack(mode);
  const brownfield = mode === "brownfield";
  const roadmap = projectCycleArtifact("roadmap.proposed", {
    schemaVersion: 1, mode,
    currentCycle: {
      name: pack.defaults.currentCycle, whyNow: pack.defaults.whyNow,
      architectureAssumptions: brownfield
        ? ["Existing behavior is authoritative until a scoped change is approved.", "Candidate regressions are compared with the base-head baseline."]
        : ["Begin with one dependency-light walking skeleton.", "Defer security, datastore, and scale choices until the skeleton is proven."],
      adrRefs: context.adrRefs || [],
      exitCriteria: slice.acceptanceChecks,
      risksAndDependencies: brownfield
        ? ["Undocumented behavior or baseline failures may require a human decision."]
        : ["A later cycle must decide persistence, security, and scale requirements when they become relevant."],
    },
    nextSlice: { title: slice.title, objective: request, acceptanceChecks: slice.acceptanceChecks },
  });
  return Object.freeze({ pack, roadmap });
}

export function nextProjectCycleArtifacts(run) {
  const roadmap = run.projectCycle?.roadmap?.content;
  if (!roadmap || run.projectCycle?.completion) return null;
  const files = Array.isArray(run.worker?.report?.files) ? run.worker.report.files : [];
  const completion = projectCycleArtifact("slice.completed", {
    schemaVersion: 1, outcome: "passed", changedFiles: files,
    validationSummary: "No-mistakes passed the exact isolated candidate.",
  });
  const next = projectCycleArtifact("roadmap.next_proposed", {
    schemaVersion: 1, mode: roadmap.mode,
    currentCycle: {
      ...roadmap.currentCycle,
      name: roadmap.mode === "greenfield" ? "Strengthen the walking skeleton" : "Extend characterized behavior",
      whyNow: "The prior bounded slice passed, so one follow-up can now be considered without scheduling it.",
      exitCriteria: ["The proposed follow-up remains bounded and passes exact-head validation."],
    },
    nextSlice: roadmap.mode === "greenfield" ? {
      title: "Strengthen the proven skeleton",
      objective: "Improve one user-facing quality of the proven walking skeleton without adding datastore, scale, or publication scope.",
      acceptanceChecks: ["The selected quality improvement is observable and exact-head validation passes."],
    } : {
      title: "Select one characterized follow-up",
      objective: "Extend one characterized behavior while preserving the recorded baseline.",
      acceptanceChecks: ["Existing behavior remains characterized and the candidate introduces no unapproved regression."],
    },
  });
  return { completion, next };
}

export function projectCycleArtifact(kind, content) {
  const schema = kind === "slice.completed" ? CompletionSchema :
    new Set(["roadmap.proposed", "roadmap.next_proposed"]).has(kind) ? RoadmapSchema : null;
  if (!schema) throw new TypeError(`Unsupported project cycle artifact: ${kind}`);
  const parsed = schema.parse(content);
  return Object.freeze({ kind, schemaVersion: 1, content: parsed, digest: digest({ kind, content: parsed }) });
}

export function verifyProjectCycleArtifact(kind, value) {
  const verified = projectCycleArtifact(kind, value.content);
  if (value.schemaVersion !== verified.schemaVersion || value.digest !== verified.digest) {
    throw new TypeError("Project cycle artifact digest does not match its content");
  }
  return verified;
}

export function renderProjectRoadmap(run) {
  const roadmap = run.projectCycle?.roadmap?.content;
  if (!roadmap) return "No project cycle roadmap has been recorded yet.";
  const cycle = roadmap.currentCycle;
  const proposed = run.projectCycle?.nextRoadmap?.content;
  return [
    `Current project cycle: ${cycle.name}`,
    `Why now: ${cycle.whyNow}`,
    `Next bounded slice: ${roadmap.nextSlice.title} — ${roadmap.nextSlice.objective}`,
    `Exit criteria: ${cycle.exitCriteria.join("; ")}`,
    ...(cycle.risksAndDependencies.length ? [`Risks or decisions: ${cycle.risksAndDependencies.join("; ")}`] : []),
    ...(proposed ? [
      `Proposed next cycle: ${proposed.currentCycle.name}`,
      `Proposed next bounded slice: ${proposed.nextSlice.title} — ${proposed.nextSlice.objective}`,
      "Next: review the proposal and start a new scoped plan if wanted. It is not approved or scheduled.",
    ] : [
      "Next: approve the displayed current slice once, or leave it unchanged. A later slice is never scheduled automatically.",
    ]),
  ].join("\n");
}

function cyclePack(name, defaults) {
  const content = { schemaVersion: 1, name, version: "1.0.0", defaults };
  return Object.freeze({ ...content, digest: digest(content) });
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
