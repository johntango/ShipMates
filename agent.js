import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { Agent, MemorySession, run } from "@openai/agents";

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set.");
  console.error('Run: export OPENAI_API_KEY="sk-..."');
  process.exit(1);
}

const agent = new Agent({
  name: "Terminal Assistant",
  instructions: `
You are a concise technical assistant running inside a terminal.
Answer clearly and directly.
Use short answers unless the user asks for more detail.
`,
});

const session = new MemorySession({
  sessionId: "nvim-terminal-session",
});

const terminal = readline.createInterface({ input, output });

console.log("OpenAI JavaScript Agent");
console.log("Type exit or quit to stop.\n");

try {
  while (true) {
    const userInput = (await terminal.question("You: ")).trim();

    if (!userInput) {
      continue;
    }

    if (["exit", "quit"].includes(userInput.toLowerCase())) {
      break;
    }

    try {
      const result = await run(agent, userInput, {
        session,
      });

      console.log(`\nAgent: ${result.finalOutput}\n`);
    } catch (error) {
      console.error("\nAgent error:", error.message);
      console.log();
    }
  }
} finally {
  terminal.close();
  console.log("\nGoodbye.");
}