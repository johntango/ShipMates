#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createFirstMateMcpServerFromEnvironment } from "../src/firstmate/mcp-server.js";

try {
  const server = createFirstMateMcpServerFromEnvironment();
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 128 * 1024,
  }));
} catch (error) {
  process.stderr.write(`First Mate MCP could not start: ${safeMessage(error)}\n`);
  process.exitCode = 1;
}

function safeMessage(error) {
  return error instanceof Error && error.message
    ? error.message.replace(/[\r\n]+/gu, " ").slice(0, 1_000)
    : "unknown startup error";
}
