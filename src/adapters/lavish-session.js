import { spawn } from "node:child_process";
import path from "node:path";

const allowedActions = new Set(["show_files", "show_status", "show_validation"]);
const allowedDecisions = new Set(["deliver_changes", "review_files", "review_validation", "no_action"]);

export class LavishSessionManager {
  constructor({
    nodePath = process.execPath,
    cliPath = path.resolve("node_modules/lavish-axi/dist/cli.mjs"),
    spawnProcess = spawn,
    env = process.env,
    onWarning = console.error,
  } = {}) {
    this.nodePath = nodePath;
    this.cliPath = cliPath;
    this.spawnProcess = spawnProcess;
    this.env = env;
    this.onWarning = onWarning;
    this.pollers = new Map();
  }

  async open({ dashboardPath, taskId, onAction, onFeedback = null, reopen = false }) {
    const opened = await this.#run([
      this.cliPath,
      dashboardPath,
      ...(reopen ? ["--reopen"] : []),
    ]);
    if (opened.exitCode !== 0) throw new Error("Lavish dashboard session could not open");
    this.#poll({ dashboardPath, taskId, onAction, onFeedback });
  }

  #poll({ dashboardPath, taskId, onAction, onFeedback, agentReply = null }) {
    const args = [this.cliPath, "poll", dashboardPath];
    if (agentReply) args.push("--agent-reply", agentReply);
    const child = this.spawnProcess(this.nodePath, args, {
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.pollers.set(taskId, child);
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.once("error", (error) => this.onWarning(`Lavish poll failed (${error.name})`));
    child.once("exit", async (exitCode) => {
      if (this.pollers.get(taskId) !== child) return;
      this.pollers.delete(taskId);
      if (exitCode !== 0) {
        this.onWarning(`Lavish poll stopped for ${taskId}`);
        return;
      }
      const actions = [
        ...parseLavishActions(stdout, taskId),
        ...parseLavishDecisions(stdout, taskId),
      ];
      let reply = null;
      if (actions.length > 0) reply = await onAction(actions.at(-1));
      else if (/prompts\[[1-9]\d*\]/u.test(stdout) && onFeedback) {
        reply = await onFeedback({ taskId, dashboardPath });
      }
      if (!/status:\s*ended|session_ended:\s*true/u.test(stdout)) {
        this.#poll({ dashboardPath, taskId, onAction, onFeedback, agentReply: reply });
      }
    });
  }

  #run(args) {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(this.nodePath, args, {
        env: this.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (exitCode) => resolve({ exitCode, stdout, stderr }));
    });
  }
}

export function parseLavishActions(output, expectedTaskId) {
  const actions = [];
  const pattern = /shipmates-action:v1:(show_files|show_status|show_validation):(task-[a-z0-9]+)/gu;
  for (const match of String(output).matchAll(pattern)) {
    if (match[2] === expectedTaskId && allowedActions.has(match[1])) {
      actions.push({ schemaVersion: 1, action: match[1], taskId: match[2] });
    }
  }
  const reviewPattern = /shipmates-action:v1:review_file_(\d+):(task-[a-z0-9]+)/gu;
  for (const match of String(output).matchAll(reviewPattern)) {
    if (match[2] === expectedTaskId) {
      actions.push({
        schemaVersion: 1,
        action: "review_file",
        fileIndex: Number(match[1]),
        taskId: match[2],
      });
    }
  }
  return actions;
}

export function parseLavishDecisions(output, expectedTaskId) {
  const decisions = [];
  const pattern = /shipmates-decision:v1:(deliver_changes|review_files|review_validation|no_action):(task-[a-z0-9]+)/gu;
  for (const match of String(output).matchAll(pattern)) {
    if (match[2] === expectedTaskId && allowedDecisions.has(match[1])) {
      decisions.push({ schemaVersion: 1, decision: match[1], taskId: match[2] });
    }
  }
  return decisions;
}
