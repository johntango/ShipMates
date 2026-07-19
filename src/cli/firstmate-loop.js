const exitCommands = new Set(["/exit", "exit", "quit"]);

export async function runFirstmateLoop({ askMessage, runRequest, onReady } = {}) {
  if (typeof askMessage !== "function" || typeof runRequest !== "function") {
    throw new TypeError("runFirstmateLoop requires askMessage and runRequest");
  }
  await onReady?.();
  let completed = 0;
  while (true) {
    let answer;
    try {
      answer = await askMessage("You: ");
    } catch (error) {
      if (new Set(["ABORT_ERR", "ERR_USE_AFTER_CLOSE"]).has(error?.code)) break;
      throw error;
    }
    if (answer === undefined || answer === null) break;
    let message = String(answer).trim();
    if (!message) continue;
    if (exitCommands.has(message.toLowerCase())) break;
    if (message.toLowerCase() === "/paste") {
      const lines = [];
      while (true) {
        const line = await askMessage(lines.length === 0
          ? "Paste your instruction; enter /send when finished or /cancel to discard:\n> "
          : "> ");
        if (line === undefined || line === null) break;
        const command = String(line).trim().toLowerCase();
        if (command === "/cancel") {
          lines.length = 0;
          break;
        }
        if (command === "/send" || command === ".") break;
        lines.push(String(line));
      }
      message = lines.join("\n").trim();
      if (!message) continue;
    }
    await runRequest(message);
    completed += 1;
  }
  return { completed };
}
