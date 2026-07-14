import path from "node:path";

import { ExactHeadGitPushAdapter } from "../src/adapters/git-push.js";
import { GitHubReadGateway } from "../src/adapters/github-read.js";
import { TaskStore } from "../src/storage/task-store.js";
import { ExactHeadPushWorkflow } from "../src/workflows/git-push.js";

const [command, ...args] = process.argv.slice(2);
const workflow = new ExactHeadPushWorkflow({
  store: new TaskStore({
    rootDir: path.resolve(process.env.SHIPMATES_STATE_DIR || ".shipmates"),
  }),
  pushAdapter: new ExactHeadGitPushAdapter(),
  readGateway: new GitHubReadGateway(),
  actor: process.env.SHIPMATES_ACTOR || "firstmate",
});

let result;
switch (command) {
  case "approve": {
    exactArguments(command, args, 5);
    const humanActor = process.env.SHIPMATES_HUMAN_ACTOR;
    if (!humanActor) throw new Error("approve requires SHIPMATES_HUMAN_ACTOR");
    const [taskId, approvalId, repository, branch, headSha] = args;
    result = await workflow.approve({
      taskId, approvalId, humanActor, repository, branch, headSha,
    });
    break;
  }
  case "push": {
    exactArguments(command, args, 6);
    const [taskId, operationId, approvalId, repository, branch, headSha] = args;
    result = await workflow.push({
      taskId, operationId, approvalId, repository, branch, headSha,
    });
    break;
  }
  case "reconcile": {
    exactArguments(command, args, 2);
    result = await workflow.reconcile({ taskId: args[0], operationId: args[1] });
    break;
  }
  default:
    usage();
}

console.log(JSON.stringify(result, null, 2));

function exactArguments(name, values, count) {
  if (values.length !== count || values.some((value) => !value)) {
    throw new Error(`${name} requires exactly ${count} arguments`);
  }
}

function usage() {
  throw new Error(
    "Usage: firstmate-push.js approve TASK APPROVAL REPO BRANCH HEAD | push TASK OPERATION APPROVAL REPO BRANCH HEAD | reconcile TASK OPERATION",
  );
}
