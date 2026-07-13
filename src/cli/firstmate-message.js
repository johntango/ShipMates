import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

export async function readFirstmateMessage({
  messageParts = [],
  input = stdin,
  output = stdout,
  askMessage,
} = {}) {
  const argumentMessage = messageParts.join(" ").trim();
  if (argumentMessage) return argumentMessage;

  if (askMessage) return readInteractiveMessage(askMessage);

  if (input.isTTY) {
    const terminal = readline.createInterface({ input, output });
    try {
      return await readInteractiveMessage((prompt) => terminal.question(prompt));
    } finally {
      terminal.close();
    }
  }

  let pipedMessage = "";
  for await (const chunk of input) pipedMessage += chunk;
  return requireMessage(pipedMessage);
}

async function readInteractiveMessage(askMessage) {
  while (true) {
    const message = String(await askMessage("You: ")).trim();
    if (message) return message;
  }
}

function requireMessage(message) {
  const normalized = String(message).trim();
  if (!normalized) {
    throw new Error("Firstmate requires a non-empty prompt on stdin");
  }
  return normalized;
}
