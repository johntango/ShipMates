import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const FIRSTMATE_INSTRUCTIONS = `You are Firstmate, a persistent Codex coding-project coordinator.
Talk to the human naturally and concisely. Inspect the repository when useful. Never claim work
without evidence. You have read-only repository and shell access in this turn. Mutating work must
be delegated through ShipMates after this turn; GitHub writes remain separately human-approved.
Choose exactly one action:
- answer: explain, report status, or ask a truly necessary question; instruction must be null.
- control: act on one existing task without creating implementation work. Use accept_demo_warning,
  show_status, or resume_existing and return the exact existing taskId. Never dispatch approvals,
  recovery, reconciliation, status requests, or accepted warnings as new work.
- dispatch: one concrete bounded coding or inspection task is ready; preserve the user's full intent
  in instruction. If it implements a stored planned task, return its exact id in planTaskId; otherwise
  planTaskId is null. Do not split one request into duplicate work.
- plan: the human supplied a broader project objective that needs multiple dependent tasks. Return
  a useful project plan of up to 12 tasks. Use stable short ids and dependsOn ids. Do not dispatch it yet.
The response is what the human sees. Do not expose internal JSON, schemas, or authority labels.`;

export class FirstmateCodexConversation {
  constructor({
    rootDir = path.resolve(".shipmates"),
    binary = process.env.CODEX_BIN || "codex",
    schemaPath = path.resolve("schemas/firstmate-conversation.schema.json"),
    runProcess = run,
  } = {}) {
    this.directory = path.join(path.resolve(rootDir), "firstmate-conversation");
    this.binary = binary;
    this.schemaPath = schemaPath;
    this.runProcess = runProcess;
  }

  async turn({ message, workingDirectory, project }) {
    if (typeof message !== "string" || !message.trim()) throw new TypeError("Firstmate message is required");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const session = await this.#session();
    const turnId = `turn-${Date.now()}`;
    const reportPath = path.join(this.directory, `${turnId}.json`);
    const eventsPath = path.join(this.directory, `${turnId}.jsonl`);
    const stderrPath = path.join(this.directory, `${turnId}.stderr.log`);
    const prompt = `${session ? "Continue the existing conversation." : FIRSTMATE_INSTRUCTIONS}\n\nProject registry context:\n${JSON.stringify(project)}\n\nHuman message:\n${message}`;
    const args = ["exec", "--sandbox", "read-only", "--color", "never", "--json",
      "--output-schema", this.schemaPath, "--output-last-message", reportPath,
      "--cd", path.resolve(workingDirectory)];
    if (session) args.push("resume", session.threadId, prompt);
    else args.push(prompt);
    const result = await this.runProcess({
      file: this.binary, args, cwd: path.resolve(workingDirectory), eventsPath, stderrPath,
    });
    if (result.exitCode !== 0) throw new Error("Firstmate Codex turn failed");
    const events = (await readFile(eventsPath, "utf8")).split(/\r?\n/u).filter(Boolean).map(JSON.parse);
    const threadId = events.find(({ type }) => type === "thread.started")?.thread_id || session?.threadId;
    if (!threadId || !events.some(({ type }) => type === "turn.completed")) {
      throw new Error("Firstmate Codex turn did not complete");
    }
    const decision = validateDecision(JSON.parse(await readFile(reportPath, "utf8")));
    await this.#saveSession({ schemaVersion: 1, threadId, updatedAt: new Date().toISOString() });
    return decision;
  }

  async #session() {
    try {
      const value = JSON.parse(await readFile(path.join(this.directory, "session.json"), "utf8"));
      return value?.schemaVersion === 1 && typeof value.threadId === "string" ? value : null;
    } catch { return null; }
  }

  async #saveSession(value) {
    const target = path.join(this.directory, "session.json");
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }
}

function validateDecision(value) {
  if (!value || !new Set(["answer", "control", "dispatch", "plan"]).has(value.action) ||
    typeof value.response !== "string" || !Array.isArray(value.tasks)) {
    throw new Error("Firstmate Codex returned an invalid decision");
  }
  if (value.action === "dispatch" && (typeof value.instruction !== "string" || !value.instruction.trim())) {
    throw new Error("Firstmate dispatch requires an instruction");
  }
  if (value.action === "control" &&
    (!new Set(["accept_demo_warning", "show_status", "resume_existing"]).has(value.controlType) ||
      typeof value.taskId !== "string")) {
    throw new Error("Firstmate control action requires a supported type and exact task id");
  }
  if (value.planTaskId !== null && typeof value.planTaskId !== "string") {
    throw new Error("Firstmate planTaskId must be a string or null");
  }
  if (value.action === "plan" && (typeof value.objective !== "string" || !value.objective.trim() || value.tasks.length === 0)) {
    throw new Error("Firstmate plan requires an objective and tasks");
  }
  return value;
}

function run({ file, args, cwd, eventsPath, stderrPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", async (exitCode, signal) => {
      await Promise.all([
        writeFile(eventsPath, stdout, { encoding: "utf8", mode: 0o600 }),
        writeFile(stderrPath, stderr, { encoding: "utf8", mode: 0o600 }),
      ]);
      resolve({ exitCode: exitCode ?? 1, signal });
    });
  });
}
