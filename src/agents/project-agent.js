import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";

const emptyParameters = z.object({}).strict();

export function createProjectAgentTools({ project, task, operations, observer = null }) {
  requireOperations(operations);
  const wrap = (stage, operation) => async (input) => {
    await observer?.stage(project, { state: "working", status: stage, message: `${task.title}: ${stage}` });
    return operation(input);
  };
  return [
    tool({
      name: "inspect_project_status",
      description: "Read the fixed project's durable task and execution status without changing anything.",
      parameters: emptyParameters, needsApproval: false,
      execute: wrap("inspecting", () => operations.inspect()),
    }),
    tool({
      name: "dispatch_implementer",
      description: "Run exactly one Implementer for this fixed planned task in its persistent project worktree, including focused tests and a controlled project commit.",
      parameters: z.object({ instruction: z.string().trim().min(1).max(20_000) }).strict(),
      needsApproval: false, timeoutMs: 3_600_000, timeoutBehavior: "raise_exception", errorFunction: null,
      execute: wrap("implementing", ({ instruction }) => operations.dispatchImplementer(instruction)),
    }),
    tool({
      name: "reconcile_implementer",
      description: "Reconcile an existing Implementer terminal artifact. Never launches another Implementer.",
      parameters: emptyParameters, needsApproval: false,
      execute: wrap("reconciling", () => operations.reconcileImplementer()),
    }),
    tool({
      name: "run_milestone_validation",
      description: "Run full pinned no-mistakes validation only when this task is the terminal project milestone.",
      parameters: z.object({ intent: z.string().trim().min(1).max(20_000) }).strict(),
      needsApproval: false, timeoutMs: 3_600_000, timeoutBehavior: "raise_exception", errorFunction: null,
      execute: wrap("validating", ({ intent }) => operations.validateMilestone(intent)),
    }),
    tool({
      name: "request_human_attention",
      description: "Refer a blocked, overdue, or approval-gated project operation to Firstmate and the human.",
      parameters: z.object({ reason: z.string().trim().min(1).max(2_000) }).strict(),
      needsApproval: false,
      execute: wrap("awaiting-human", ({ reason }) => operations.requestAttention(reason)),
    }),
  ];
}

export function createProjectAgent({ project, task, tools, model = "gpt-5.6-luna" }) {
  return new Agent({
    name: `${project.name} Project Agent`,
    model,
    instructions: `You are the lifecycle controller for exactly project ${project.name} and planned task ${task.title}.
Use only the supplied bounded tools. You have no shell and no authority over another project.
Inspect status first. Reconcile durable incomplete work before dispatching. Dispatch at most one Implementer.
The Implementer owns edits and focused tests. Run milestone validation only if status says this is a terminal milestone.
If approval or recovery is required, call request_human_attention. Never push, publish, delete, or invent success.`,
    tools,
    handoffs: [],
    modelSettings: { reasoning: { effort: "none" }, maxTokens: 512, store: false, parallelToolCalls: false },
    outputType: z.object({
      status: z.enum(["completed", "blocked", "awaiting_human"]),
      summary: z.string().trim().min(1).max(2_000),
    }).strict(),
  });
}

export class ProjectAgentController {
  constructor({ project, task, operations, observer = null, model, runAgent = run } = {}) {
    if (!project || !task || typeof runAgent !== "function") throw new TypeError("ProjectAgentController requires project, task, and runAgent");
    this.project = project;
    this.task = task;
    this.observer = observer;
    this.operations = operations;
    this.lifecycle = { implementation: null, validation: null, attention: null };
    const tracked = {
      ...operations,
      dispatchImplementer: async (instruction) => {
        this.lifecycle.implementation = await operations.dispatchImplementer(instruction);
        return this.lifecycle.implementation;
      },
      reconcileImplementer: async () => {
        this.lifecycle.implementation = await operations.reconcileImplementer();
        return this.lifecycle.implementation;
      },
      validateMilestone: async (intent) => {
        this.lifecycle.validation = await operations.validateMilestone(intent);
        return this.lifecycle.validation;
      },
      requestAttention: async (reason) => {
        this.lifecycle.attention = await operations.requestAttention(reason);
        return this.lifecycle.attention;
      },
    };
    this.tools = createProjectAgentTools({ project, task, operations: tracked, observer });
    this.agent = createProjectAgent({ project, task, tools: this.tools, model });
    this.runAgent = runAgent;
  }

  async execute(instruction) {
    await this.observer?.stage(this.project, { state: "working", status: "coordinating", message: `${this.task.title}: coordinating` });
    try {
      const result = await this.runAgent(this.agent,
        `Execute this approved planned task through the bounded project lifecycle:\n${instruction}`,
        { maxTurns: 6, tracingDisabled: true, traceIncludeSensitiveData: false,
          workflowName: `ShipMates ${this.project.name} Project Agent`, groupId: this.project.id });
      let output = result.finalOutput;
      if (!output || !new Set(["completed", "blocked", "awaiting_human"]).has(output.status)) {
        throw new Error("Project Agent returned an invalid result");
      }
      // Model prose is never terminal evidence. Reconcile first, then enforce
      // the one-Implementer lifecycle if the Agent failed to invoke its tool.
      if (!this.lifecycle.implementation && !this.lifecycle.attention) {
        this.lifecycle.implementation = await this.operations.reconcileImplementer();
      }
      if (!new Set(["completed", "blocked"]).has(this.lifecycle.implementation?.status) &&
        !this.lifecycle.attention) {
        this.lifecycle.implementation = await this.operations.dispatchImplementer(instruction);
      }
      if (this.lifecycle.implementation?.status === "completed") {
        const status = await this.operations.inspect();
        if (status.terminalMilestone && !this.lifecycle.validation) {
          this.lifecycle.validation = await this.operations.validateMilestone(instruction);
        }
        output = this.lifecycle.validation && this.lifecycle.validation.passed === false
          ? { status: "blocked", summary: `${this.task.title}: milestone validation did not pass` }
          : { status: "completed", summary: `${this.task.title}: implementation completed` };
      } else if (this.lifecycle.implementation?.status === "blocked") {
        output = { status: "blocked", summary: `${this.task.title}: Implementer reported a blocker` };
      } else if (!this.lifecycle.attention) {
        throw new Error("Project Agent produced no terminal Implementer evidence");
      }
      await this.observer?.stage(this.project, {
        state: output.status === "completed" ? "idle" : "blocked",
        status: output.status, message: output.summary,
      });
      return output;
    } catch (error) {
      await this.observer?.stage(this.project, { state: "blocked", status: "failed", message: `${this.task.title}: controller failed` });
      throw error;
    }
  }
}

function requireOperations(operations) {
  for (const name of ["inspect", "dispatchImplementer", "reconcileImplementer", "validateMilestone", "requestAttention"]) {
    if (typeof operations?.[name] !== "function") throw new TypeError(`Project Agent operation ${name} is required`);
  }
}
