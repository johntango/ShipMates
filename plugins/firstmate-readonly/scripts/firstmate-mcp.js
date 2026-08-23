#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = process.env.SHIPMATES_REPOSITORY_ROOT
  ? path.resolve(process.env.SHIPMATES_REPOSITORY_ROOT)
  : path.resolve(pluginRoot, "../..");
const entrypoint = pathToFileURL(path.join(repositoryRoot, "scripts/firstmate-mcp.js")).href;

await import(entrypoint);
