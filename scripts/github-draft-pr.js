import { readFile } from "node:fs/promises";
import path from "node:path";

import { GitHubDraftPullRequestGateway } from "../src/adapters/github-draft-pr.js";
import { GitHubReadGateway } from "../src/adapters/github-read.js";
import { TaskStore } from "../src/storage/task-store.js";
import { GitHubDraftPullRequestWorkflow } from "../src/workflows/github-draft-pr.js";
import { GitHubStatusWorkflow } from "../src/workflows/github-status.js";

const [command, ...args] = process.argv.slice(2);
const store = new TaskStore({
  rootDir: path.resolve(process.env.SHIPMATES_STATE_DIR || ".shipmates"),
});
const readGateway = new GitHubReadGateway();
const statusWorkflow = new GitHubStatusWorkflow({ store, gateway: readGateway });
const workflow = new GitHubDraftPullRequestWorkflow({
  store,
  readGateway,
  writeGateway: new GitHubDraftPullRequestGateway(),
  statusWorkflow,
  actor: process.env.SHIPMATES_ACTOR || "firstmate",
});

let result;
switch (command) {
  case "approve": {
    exactArguments(command, args, 8);
    const humanActor = process.env.SHIPMATES_HUMAN_ACTOR;
    if (!humanActor) {
      throw new Error("approve requires SHIPMATES_HUMAN_ACTOR");
    }
    const [
      taskId, approvalId, repository, headBranch, headSha, baseBranch,
      titleFile, bodyFile,
    ] = args;
    const { title, body } = await readContent(titleFile, bodyFile);
    result = await workflow.approve({
      taskId, approvalId, humanActor, repository, headBranch, headSha,
      baseBranch, title, body,
    });
    break;
  }
  case "create": {
    exactArguments(command, args, 9);
    const [
      taskId, operationId, approvalId, repository, headBranch, headSha,
      baseBranch, titleFile, bodyFile,
    ] = args;
    const { title, body } = await readContent(titleFile, bodyFile);
    result = await workflow.create({
      taskId, operationId, approvalId, repository, headBranch, headSha,
      baseBranch, title, body,
    });
    break;
  }
  case "reconcile": {
    exactArguments(command, args, 2);
    result = await workflow.reconcile({ taskId: args[0], operationId: args[1] });
    break;
  }
  case "ci": {
    if (args.length < 2) usage();
    const [taskId, operationId, ...requiredChecks] = args;
    result = await workflow.observeCi({ taskId, operationId, requiredChecks });
    break;
  }
  default:
    usage();
}

console.log(JSON.stringify(result, null, 2));

async function readContent(titleFile, bodyFile) {
  return {
    title: (await readFile(path.resolve(titleFile), "utf8")).trim(),
    body: await readFile(path.resolve(bodyFile), "utf8"),
  };
}

function exactArguments(name, values, count) {
  if (values.length !== count || values.some((value) => !value)) {
    throw new Error(`${name} requires exactly ${count} arguments`);
  }
}

function usage() {
  throw new Error(
    "Usage: github-draft-pr.js approve TASK APPROVAL REPO HEAD_BRANCH HEAD_SHA BASE TITLE_FILE BODY_FILE | create TASK OPERATION APPROVAL REPO HEAD_BRANCH HEAD_SHA BASE TITLE_FILE BODY_FILE | reconcile TASK OPERATION | ci TASK OPERATION [REQUIRED_CHECK ...]",
  );
}
