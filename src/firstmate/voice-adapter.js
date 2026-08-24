import { createHash } from "node:crypto";

import { z } from "zod";

import { FIRSTMATE_APPLICATION_SCHEMA_VERSION } from "./application-service.js";

const MAX_TRANSCRIPT_CHARS = 1_000;
const ReadIntentSchema = z.enum([
  "firstmate_status",
  "firstmate_current_design",
  "firstmate_current_plan",
  "firstmate_artifacts",
  "firstmate_technical_evidence",
]);

const VoiceReplySchema = z.object({
  schemaVersion: z.literal(FIRSTMATE_APPLICATION_SCHEMA_VERSION),
  kind: z.enum(["answer", "clarify", "unavailable"]),
  intent: ReadIntentSchema.nullable(),
  text: z.string().min(1).max(4_000),
}).strict();

export class FirstMateVoiceAdapter {
  constructor({ applicationService } = {}) {
    if (!applicationService || typeof applicationService.execute !== "function") {
      throw new TypeError("First Mate voice adapter requires an application service");
    }
    this.applicationService = applicationService;
  }

  async respondToTranscript(transcript) {
    const intent = voiceReadIntent(transcript);
    if (intent === "unavailable") return reply({
      kind: "unavailable",
      intent: null,
      text: "Voice controls are not enabled yet. I can read First Mate's status, design, plan, files, or technical evidence. Use the terminal or dashboard for approvals and other actions.",
    });
    if (!intent) return reply({
      kind: "clarify",
      intent: null,
      text: "I can check First Mate's status, design, plan, files, or technical evidence. Please say which one you want.",
    });
    const response = await this.applicationService.execute({
      schemaVersion: FIRSTMATE_APPLICATION_SCHEMA_VERSION,
      intent,
      channel: "voice",
      idempotencyKey: voiceReadKey(intent, transcript),
    });
    return reply({ kind: "answer", intent, text: voiceSummary(response) });
  }
}

export function voiceReadIntent(transcript) {
  if (typeof transcript !== "string" || transcript.length > MAX_TRANSCRIPT_CHARS) return null;
  const normalized = transcript.trim().toLowerCase().replace(/\s+/gu, " ");
  if (!normalized) return null;
  if (/\b(approve|start|launch|pause|cancel|stop|clean|wipe|delete|commit|push|publish|merge)\b/iu.test(normalized)) {
    return "unavailable";
  }
  if (/\b(technical|evidence|test(?:s|ing)?|lint|diagnostic|details?)\b/iu.test(normalized)) {
    return "firstmate_technical_evidence";
  }
  if (/\b(file|files|artifact|artifacts|page|url|link|candidate)\b/iu.test(normalized)) {
    return "firstmate_artifacts";
  }
  if (/\b(plan|slice|roadmap|cycle)\b/iu.test(normalized)) return "firstmate_current_plan";
  if (/\b(design|specification|spec|requirement|requirements)\b/iu.test(normalized)) {
    return "firstmate_current_design";
  }
  if (/\b(status|update|happening|progress|doing|outcome|result)\b/iu.test(normalized)) {
    return "firstmate_status";
  }
  return null;
}

export function voiceSummary(response) {
  const data = response?.data;
  if (!data) return response?.text || "No First Mate workflow has been recorded yet.";
  if (response.intent === "firstmate_technical_evidence") {
    return response.text.slice(0, 4_000);
  }
  const lines = [
    `First Mate: ${data.presentation.outcome}.`,
    data.presentation.why,
  ];
  if (data.presentation.nextAction) lines.push(`Next: ${data.presentation.nextAction}`);
  if (data.candidate?.pageUrl) lines.push(`Candidate page: ${data.candidate.pageUrl}`);
  if (data.candidate?.files?.length) {
    lines.push(`Files: ${data.candidate.files.slice(0, 5).map(({ relativePath }) => relativePath).join(", ")}.`);
  }
  lines.push("Say “technical evidence” if you want the detailed checks.");
  return lines.join(" ");
}

function voiceReadKey(intent, transcript) {
  const normalized = typeof transcript === "string" ? transcript.trim().toLowerCase() : "";
  return `voice:${intent}:${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
}

function reply(value) {
  return Object.freeze(VoiceReplySchema.parse({
    schemaVersion: FIRSTMATE_APPLICATION_SCHEMA_VERSION,
    ...value,
  }));
}
