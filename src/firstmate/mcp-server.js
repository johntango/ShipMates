import { randomUUID } from "node:crypto";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  FIRSTMATE_APPLICATION_SCHEMA_VERSION,
  FirstMateApplicationService,
} from "./application-service.js";
import { WorkflowRunStore } from "../workflow-run/store.js";

export const FIRSTMATE_MCP_SERVER_NAME = "firstmate-readonly";
export const FIRSTMATE_MCP_SERVER_VERSION = "0.1.0";

const ReadOnlyIntents = Object.freeze([
  {
    name: "firstmate_status",
    title: "First Mate status",
    description: "Read the current durable First Mate workflow status and safe next action.",
  },
  {
    name: "firstmate_current_design",
    title: "Current First Mate design",
    description: "Read the current durable design/specification evidence without changing it.",
  },
  {
    name: "firstmate_current_plan",
    title: "Current First Mate plan",
    description: "Read the approved or proposed bounded First Mate plan without approving it.",
  },
  {
    name: "firstmate_artifacts",
    title: "First Mate artifacts",
    description: "Read the newest completed First Mate candidate files and safe local page link.",
  },
  {
    name: "firstmate_technical_evidence",
    title: "First Mate technical evidence",
    description: "Read recorded worker and validation evidence for the current First Mate workflow.",
  },
]);

const ToolOutputSchema = z.object({
  schemaVersion: z.literal(FIRSTMATE_APPLICATION_SCHEMA_VERSION),
  intent: z.enum(ReadOnlyIntents.map(({ name }) => name)),
  revision: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  confirmationRequired: z.literal(false),
  text: z.string().min(1).max(100_000),
  data: z.unknown().nullable(),
}).strict();

export class FirstMateMcpError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "FirstMateMcpError";
  }
}

export function createFirstMateMcpServer({ applicationService } = {}) {
  if (!applicationService || typeof applicationService.execute !== "function") {
    throw new TypeError("First Mate MCP server requires an application service");
  }
  const server = new McpServer(
    { name: FIRSTMATE_MCP_SERVER_NAME, version: FIRSTMATE_MCP_SERVER_VERSION },
    {
      instructions: "First Mate tools are local and read-only. Use them for durable workflow status, design, plan, artifacts, or technical evidence. They cannot approve, start, pause, cancel, clean, change code, or publish work.",
    },
  );
  for (const tool of ReadOnlyIntents) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: z.object({}).strict(),
      outputSchema: ToolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    }, async () => toolResult(await applicationService.execute({
      schemaVersion: FIRSTMATE_APPLICATION_SCHEMA_VERSION,
      intent: tool.name,
      channel: "plugin",
      idempotencyKey: `mcp:${tool.name}:${randomUUID()}`,
    })));
  }
  return server;
}

export function createFirstMateMcpServerFromEnvironment({
  environment = process.env,
  workflowRunStore = null,
  applicationService = null,
} = {}) {
  if (applicationService) return createFirstMateMcpServer({ applicationService });
  const stateRoot = environment.SHIPMATES_STATE_DIR;
  if (typeof stateRoot !== "string" || !stateRoot.trim()) {
    throw new FirstMateMcpError(
      "First Mate MCP requires SHIPMATES_STATE_DIR and will not guess a workflow state directory",
    );
  }
  const store = workflowRunStore || new WorkflowRunStore({ rootDir: path.resolve(stateRoot) });
  return createFirstMateMcpServer({
    applicationService: new FirstMateApplicationService({ workflowRunStore: store }),
  });
}

export function firstMateMcpToolDefinitions() {
  return ReadOnlyIntents.map(({ name, title, description }) => ({
    name, title, description, readOnly: true,
  }));
}

function toolResult(response) {
  const output = ToolOutputSchema.parse({
    schemaVersion: response.schemaVersion,
    intent: response.intent,
    revision: response.revision,
    confirmationRequired: response.confirmationRequired,
    text: response.text,
    data: response.data,
  });
  return {
    content: [{ type: "text", text: output.text }],
    structuredContent: output,
  };
}
