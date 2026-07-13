import { tool } from "@openai/agents";
import { z } from "zod";

const identifier = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/u);

export function createCodexScoutTool({ workflow, timeoutMs = 3_600_000 }) {
  if (!workflow || typeof workflow.run !== "function") {
    throw new TypeError("workflow with run() is required");
  }
  return tool({
    name: "codex_scout",
    description:
      "Run one bounded read-only Codex inspection in an already leased ShipMates worktree and return Firstmate-verified evidence.",
    parameters: z
      .object({
        taskId: identifier,
        workerId: identifier,
        brief: z.string().trim().min(1).max(10_000),
      })
      .strict(),
    needsApproval: false,
    timeoutMs,
    timeoutBehavior: "raise_exception",
    errorFunction: null,
    async execute({ taskId, workerId, brief }) {
      const snapshot = await workflow.run({ taskId, workerId, brief });
      const worker = snapshot.workers.find(({ id }) => id === workerId);
      if (worker?.status !== "reported" || worker.verification?.noMutation !== true) {
        throw new Error("Codex scout did not produce a verified report");
      }
      return {
        taskId,
        workerId,
        threadId: worker.threadId,
        report: worker.report,
        verification: worker.verification,
        ledger: {
          state: snapshot.state,
          eventsCount: snapshot.eventsCount,
          lastEventId: snapshot.lastEventId,
        },
      };
    },
  });
}

export function createCodexScoutReplyTool({ workflow, timeoutMs = 3_600_000 }) {
  if (!workflow || typeof workflow.reply !== "function") {
    throw new TypeError("workflow with reply() is required");
  }
  return tool({
    name: "codex_scout_reply",
    description:
      "Continue one existing verified Codex scout thread with a crash-safe, bounded read-only prompt.",
    parameters: z
      .object({
        taskId: identifier,
        workerId: identifier,
        replyId: identifier,
        prompt: z.string().trim().min(1).max(10_000),
      })
      .strict(),
    needsApproval: false,
    timeoutMs,
    timeoutBehavior: "raise_exception",
    errorFunction: null,
    async execute({ taskId, workerId, replyId, prompt }) {
      const snapshot = await workflow.reply({ taskId, workerId, replyId, prompt });
      const worker = snapshot.workers.find(({ id }) => id === workerId);
      const reply = worker?.replies?.find(({ id }) => id === replyId);
      if (reply?.status !== "completed" || reply.verification?.noMutation !== true) {
        throw new Error("Codex scout reply did not produce a verified report");
      }
      return {
        taskId,
        workerId,
        replyId,
        threadId: reply.threadId,
        report: reply.report,
        verification: reply.verification,
        ledger: {
          state: snapshot.state,
          eventsCount: snapshot.eventsCount,
          lastEventId: snapshot.lastEventId,
        },
      };
    },
  });
}
