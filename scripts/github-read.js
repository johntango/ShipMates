import path from "node:path";

import { GitHubReadGateway } from "../src/adapters/github-read.js";
import { TaskStore } from "../src/storage/task-store.js";
import { GitHubStatusWorkflow } from "../src/workflows/github-status.js";

const [command, ...args] = process.argv.slice(2);
const gateway = new GitHubReadGateway();
const workflow = new GitHubStatusWorkflow({
  store: new TaskStore({
    rootDir: path.resolve(process.env.SHIPMATES_STATE_DIR || ".shipmates"),
  }),
  gateway,
  actor: process.env.SHIPMATES_ACTOR || "firstmate",
});

let result;
switch (command) {
  case "status": {
    if (args.length < 3) usage();
    const [taskId, repository, rawNumber, ...requiredChecks] = args;
    result = await workflow.inspectPullRequest({
      taskId,
      repository,
      prNumber: parsePositiveInteger(rawNumber, "PR number"),
      requiredChecks,
    });
    break;
  }
  case "history": {
    if (args.length !== 1) usage();
    result = await workflow.listPullRequests({ repository: args[0] });
    break;
  }
  default:
    usage();
}

console.log(JSON.stringify(result, null, 2));

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`${label} must be positive`);
  return parsed;
}

function usage() {
  throw new Error(
    "Usage: github-read.js history <owner/repo> | status <task-id> <owner/repo> <pr-number> [required-check ...]",
  );
}
