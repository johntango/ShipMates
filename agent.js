import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set.");
  console.error('Run: export OPENAI_API_KEY="sk-..."');
  process.exit(1);
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const HERDR_BIN = process.env.HERDR_BIN_PATH ?? "herdr";
const HERDR_PANE_ID = process.env.HERDR_PANE_ID;
const HERDR_AGENT_ID = process.env.HERDR_AGENT_ID ?? `shipmates-agent-${os.hostname()}-${process.pid}`;
const HERDR_AGENT_NAME = process.env.HERDR_AGENT_NAME ?? "ShipMates Terminal Agent";
const HERDR_TIMEOUT_MS = Number.parseInt(process.env.HERDR_TIMEOUT_MS ?? "1500", 10);
const HERDR_MAX_RETRIES = Number.parseInt(process.env.HERDR_MAX_RETRIES ?? "2", 10);
const HERDR_RETRY_BASE_MS = Number.parseInt(process.env.HERDR_RETRY_BASE_MS ?? "250", 10);
const HERDR_DEDUP_WINDOW_MS = Number.parseInt(process.env.HERDR_DEDUP_WINDOW_MS ?? "400", 10);
const HERDR_HEARTBEAT_MS = Number.parseInt(process.env.HERDR_HEARTBEAT_MS ?? "15000", 10);

const VALID_HERDR_STATES = new Set(["idle", "working", "blocked", "done", "unknown"]);
const execFileAsync = promisify(execFile);

let lastHerdrFingerprint = "";
let lastHerdrTimestamp = 0;
let hasWarnedHerdrNotConfigured = false;

const SYSTEM_INSTRUCTIONS = `
You are a concise technical assistant running inside a terminal.
Answer clearly and directly.
Use short answers unless the user asks for more detail.
`.trim();

function getIsoNow() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getBackoffDelayMs(attempt) {
  return HERDR_RETRY_BASE_MS * (2 ** attempt);
}

function getStateFingerprint(state, details) {
  const orderedDetails = Object.keys(details)
    .sort()
    .reduce((accumulator, key) => {
      accumulator[key] = details[key];
      return accumulator;
    }, {});

  return JSON.stringify({ state, details: orderedDetails });
}

function shouldSkipHerdrReport(state, details) {
  const fingerprint = getStateFingerprint(state, details);
  const now = Date.now();
  const isDuplicate =
    fingerprint === lastHerdrFingerprint && now - lastHerdrTimestamp < HERDR_DEDUP_WINDOW_MS;

  if (isDuplicate) {
    return true;
  }

  lastHerdrFingerprint = fingerprint;
  lastHerdrTimestamp = now;
  return false;
}

function normalizeHerdrState(state) {
  if (VALID_HERDR_STATES.has(state)) {
    return state;
  }

  return "unknown";
}

async function reportToHerdr(state, details = {}) {
  const herdrState = normalizeHerdrState(state);

  if (shouldSkipHerdrReport(herdrState, details)) {
    return;
  }

  const payload = {
    source: "shipmates:agent-js",
    agent: HERDR_AGENT_NAME,
    state: herdrState,
    message: details.message,
    customStatus: details.customStatus,
    agentSessionId: details.agentSessionId,
    agentSessionPath: details.agentSessionPath,
    seq: details.seq,
  };

  if (!HERDR_PANE_ID) {
    if (!hasWarnedHerdrNotConfigured) {
      console.error("Herdr is not connected to this process: run the agent inside a Herdr pane so HERDR_PANE_ID is set.");
      hasWarnedHerdrNotConfigured = true;
    }
    console.log(`[Herdr] ${herdrState} (${details.event ?? "event"})`);
    return;
  }

  for (let attempt = 0; attempt <= HERDR_MAX_RETRIES; attempt += 1) {
    const useCustomStatus = payload.customStatus && attempt === 0;
    const commandArgs = [
      "pane",
      "report-agent",
      HERDR_PANE_ID,
      "--source",
      payload.source,
      "--agent",
      payload.agent,
      "--state",
      payload.state,
    ];

    if (payload.message) {
      commandArgs.push("--message", payload.message);
    }

    if (useCustomStatus) {
      commandArgs.push("--custom-status", payload.customStatus);
    }

    if (payload.seq !== undefined) {
      commandArgs.push("--seq", String(payload.seq));
    }

    if (payload.agentSessionId) {
      commandArgs.push("--agent-session-id", payload.agentSessionId);
    }

    if (payload.agentSessionPath) {
      commandArgs.push("--agent-session-path", payload.agentSessionPath);
    }

    try {
      await Promise.race([
        execFileAsync(HERDR_BIN, commandArgs),
        sleep(HERDR_TIMEOUT_MS).then(() => {
          throw new Error(`Herdr report timed out after ${HERDR_TIMEOUT_MS} ms`);
        }),
      ]);

      if (attempt <= HERDR_MAX_RETRIES) {
        return;
      }
    } catch (error) {
      if (payload.customStatus && useCustomStatus) {
        const stderr = error.stderr || error.message || "";
        if (stderr.includes("--custom-status")) {
          void reportToHerdr(state, {
            ...details,
            customStatus: undefined,
            message: `${details.message ? `${details.message}; ` : ""}custom status unsupported in herdr`,
          });
        }
      }

      if (attempt === HERDR_MAX_RETRIES) {
        console.error("Herdr report failed:", error.stderr || error.message);
        return;
      }
    }

    await sleep(getBackoffDelayMs(attempt));
  }
}

async function releaseFromHerdr() {
  if (!HERDR_PANE_ID) {
    return;
  }

  try {
    await Promise.race([
      execFileAsync(HERDR_BIN, [
        "pane",
        "release-agent",
        HERDR_PANE_ID,
        "--source",
        "shipmates:agent-js",
        "--agent",
        HERDR_AGENT_NAME,
      ]),
      sleep(HERDR_TIMEOUT_MS).then(() => {
        throw new Error(`Herdr release timed out after ${HERDR_TIMEOUT_MS} ms`);
      }),
    ]);
  } catch (error) {
    console.error("Herdr release failed:", error.stderr || error.message);
  }
}

async function registerAgentWithHerdr() {
  await reportToHerdr("working", {
    event: "registered",
    model: OPENAI_MODEL,
    runtime: "node",
    customStatus: "running",
  });
}

function nextMessages(history, userInput) {
  return [...history, { role: "user", content: userInput }];
}

async function callModel(messages) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: SYSTEM_INSTRUCTIONS,
      input: messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${body}`);
  }

  return response.json();
}

function getAssistantText(apiResponse) {
  if (typeof apiResponse.output_text === "string" && apiResponse.output_text.trim()) {
    return apiResponse.output_text.trim();
  }

  const chunks = [];
  for (const item of apiResponse.output ?? []) {
    for (const contentItem of item.content ?? []) {
      if (contentItem.type === "output_text" && contentItem.text) {
        chunks.push(contentItem.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

function addAssistantMessage(history, text) {
  return [...history, { role: "assistant", content: text }];
}

async function runAgentLoop() {
  const terminal = readline.createInterface({ input, output });
  let history = [];
  let shuttingDown = false;

  console.log("OpenAI JavaScript Agent");
  console.log("Type exit or quit to stop.\n");
  void registerAgentWithHerdr();
  void reportToHerdr("working", { event: "starting", model: OPENAI_MODEL, customStatus: "running" });
  const heartbeatId = setInterval(() => {
    void reportToHerdr("working", { event: "heartbeat", customStatus: "running" });
  }, HERDR_HEARTBEAT_MS);
  heartbeatId.unref?.();

  async function shutdown(reason) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    clearInterval(heartbeatId);
    await releaseFromHerdr();
    terminal.close();
    console.log("\nGoodbye.");
  }

  process.once("SIGINT", () => {
    void shutdown("sigint");
  });

  process.once("SIGTERM", () => {
    void shutdown("sigterm");
  });

  try {
    while (true) {
      void reportToHerdr("working", { event: "waiting_for_input", customStatus: "running" });

      let userInput;
      try {
        userInput = (await terminal.question("You: ")).trim();
      } catch (error) {
        if (error?.code === "ABORT_ERR") {
          break;
        }

        throw error;
      }

      if (!userInput) {
        continue;
      }

      if (["exit", "quit"].includes(userInput.toLowerCase())) {
        await shutdown("user_exit");
        break;
      }

      try {
        void reportToHerdr("working", { event: "processing", userInputLength: userInput.length });
        const requestMessages = nextMessages(history, userInput);
        const apiResponse = await callModel(requestMessages);
        const answer = getAssistantText(apiResponse) || "(No response text)";
        history = addAssistantMessage(requestMessages, answer);

        void reportToHerdr("working", {
          event: "responded",
          responseId: apiResponse.id,
          outputLength: answer.length,
          customStatus: "running",
        });
        console.log(`\nAgent: ${answer}\n`);
      } catch (error) {
        void reportToHerdr("blocked", { event: "error", message: error.message });
        console.error("\nAgent error:", error.message);
        console.log();
      }
    }
  } finally {
    await shutdown("finally");
  }
}

try {
  await runAgentLoop();
} catch (error) {
  if (error?.code !== "ABORT_ERR") {
    throw error;
  }
}
