export const FIRSTMATE_COMMANDS = Object.freeze([
  "project.create", "project.approve", "project.advance",
  "task.inspect", "task.reconcile", "validation.approve",
  "delivery.retry", "project.archive", "repository.purge",
]);

const schemas = Object.freeze({
  "project.create": required("name", "repoPath"),
  "project.approve": required("projectId"),
  "project.advance": required("projectId"),
  "task.inspect": required("taskId"),
  "task.reconcile": required("taskId"),
  "validation.approve": required("taskId", "approvalId"),
  "delivery.retry": required("taskId", "operationId"),
  "project.archive": required("projectId"),
  "repository.purge": required("projectId", "approvalId"),
});

export class FirstmateControlPlane {
  constructor({ handlers = {} } = {}) { this.handlers = handlers; }

  async execute(command) {
    const normalized = validateCommand(command);
    const handler = this.handlers[normalized.type];
    if (typeof handler !== "function") {
      throw new ControlPlaneRefusal({
        command: normalized.type,
        invariant: "handler_configured",
        reason: `No deterministic handler is configured for ${normalized.type}`,
        nextAction: "configure the typed command handler",
      });
    }
    try {
      return await handler(normalized.input);
    } catch (error) {
      if (error instanceof ControlPlaneRefusal) throw error;
      throw new ControlPlaneRefusal({
        command: normalized.type,
        invariant: error.invariant || "command_preconditions_hold",
        reason: error.message,
        nextAction: error.nextAction || "inspect authoritative state and retry the same typed command",
        cause: error,
      });
    }
  }
}

export class ControlPlaneRefusal extends Error {
  constructor({ command, invariant, reason, nextAction, cause } = {}) {
    super(`${command} refused: invariant ${invariant} failed — ${reason}. Next action: ${nextAction}`, { cause });
    this.name = "ControlPlaneRefusal";
    this.command = command;
    this.invariant = invariant;
    this.reason = reason;
    this.nextAction = nextAction;
  }

  toJSON() {
    return {
      accepted: false, command: this.command, invariant: this.invariant,
      reason: this.reason, nextAction: this.nextAction,
    };
  }
}

export function validateCommand(command) {
  if (!command || !FIRSTMATE_COMMANDS.includes(command.type)) {
    throw new ControlPlaneRefusal({
      command: command?.type || "unknown", invariant: "known_command",
      reason: "The requested lifecycle command is not in the bounded vocabulary",
      nextAction: `choose one of: ${FIRSTMATE_COMMANDS.join(", ")}`,
    });
  }
  const input = command.input && typeof command.input === "object" && !Array.isArray(command.input)
    ? command.input : {};
  const missing = schemas[command.type].filter((field) => !validValue(input[field]));
  if (missing.length > 0) {
    throw new ControlPlaneRefusal({
      command: command.type, invariant: "required_command_input",
      reason: `Missing or invalid fields: ${missing.join(", ")}`,
      nextAction: "supply the required stable identifiers",
    });
  }
  return Object.freeze({ type: command.type, input: Object.freeze({ ...input }) });
}

export function selectFirstmateCommand(message) {
  if (typeof message !== "string") return null;
  const taskId = message.match(/\btask-[a-z0-9][a-z0-9._-]*\b/iu)?.[0] || null;
  const projectId = message.match(/\bproject-[a-z0-9][a-z0-9._-]*\b/iu)?.[0] || null;
  if (taskId && /\breconcile\b/iu.test(message)) return command("task.reconcile", { taskId });
  if (taskId && /\b(?:inspect|status|show)\b/iu.test(message)) return command("task.inspect", { taskId });
  if (projectId && /\bapprove\b/iu.test(message)) return command("project.approve", { projectId });
  if (projectId && /\b(?:advance|continue)\b/iu.test(message)) return command("project.advance", { projectId });
  if (projectId && /\barchive\b/iu.test(message)) return command("project.archive", { projectId });
  return null;
}

function required(...fields) { return Object.freeze(fields); }
function validValue(value) { return typeof value === "string" && value.trim() !== "" && value.length <= 512; }
function command(type, input) { return Object.freeze({ type, input: Object.freeze(input) }); }
