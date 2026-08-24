#!/usr/bin/env node
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repositoryRoot = process.env.SHIPMATES_REPOSITORY_ROOT
  ? path.resolve(process.env.SHIPMATES_REPOSITORY_ROOT)
  : null;

if (!repositoryRoot) {
  process.stderr.write(
    "First Mate MCP launcher requires SHIPMATES_REPOSITORY_ROOT.\n",
  );
  process.exitCode = 1;
} else {
  const entrypoint = pathToFileURL(path.join(repositoryRoot, "scripts/firstmate-mcp.js")).href;
  import(entrypoint).catch((error) => {
    const message = error instanceof Error ? error.message : "unknown startup error";
    process.stderr.write(`First Mate MCP launcher could not load ShipMates: ${message}\n`);
    process.exitCode = 1;
  });
}
