import { readFile } from "node:fs/promises";
import path from "node:path";

import { HerdrPaneClient } from "../src/adapters/herdr-pane.js";

const directory = path.resolve(process.argv[2] || "");
const paneId = process.argv[3] || null;
const source = process.argv[4] || null;
if (!process.argv[2]) throw new Error("Usage: workflow-run-pane.js OPERATION_DIRECTORY [PANE_ID SOURCE]");

console.log("ShipMates Implementer — preparing isolated workspace");
let seen = 0;
for (;;) {
  const events = await text(path.join(directory, "codex", "codex-events.jsonl")) || "";
  const lines = events.split(/\r?\n/u).filter(Boolean);
  for (const line of lines.slice(seen)) {
    try {
      const event = JSON.parse(line);
      const message = describe(event);
      if (message) console.log(message);
    } catch { /* Durable worker validation owns malformed artifact handling. */ }
  }
  seen = lines.length;
  if (await exists(path.join(directory, "result.json"))) {
    console.log("ShipMates Implementer — candidate commit ready");
    await finish("idle", "Candidate commit ready", "completed");
    break;
  }
  if (await exists(path.join(directory, "failure.json"))) {
    console.log("ShipMates Implementer — stopped safely; see First Mate");
    await finish("blocked", "Stopped safely; see First Mate", "blocked");
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function finish(state, message, customStatus) {
  if (!paneId || !source) return;
  await new HerdrPaneClient().reportAgent({
    paneId, source, agent: "ShipMates Implementer", state, message,
    customStatus, seq: 2,
  }).catch(() => {});
}

async function exists(target) { return (await text(target)) !== null; }
async function text(target) {
  try { return await readFile(target, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function describe(event) {
  if (event?.type === "thread.started") return "Implementer started";
  if (event?.type === "turn.completed") return "Implementation turn completed";
  if (event?.type !== "item.started" && event?.type !== "item.completed") return null;
  const phase = event.type === "item.started" ? "started" : "completed";
  const label = {
    command_execution: "Focused check",
    file_change: "File update",
    mcp_tool_call: "Tool action",
    web_search: "Reference search",
  }[event.item?.type];
  return label ? `${label} ${phase}` : null;
}
