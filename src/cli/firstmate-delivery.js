import { readFile } from "node:fs/promises";
import path from "node:path";

import { GitHubDraftPullRequestGateway } from "../adapters/github-draft-pr.js";
import { GitHubMergeGateway } from "../adapters/github-merge.js";
import { GitHubReadGateway } from "../adapters/github-read.js";
import { ExactHeadGitPushAdapter } from "../adapters/git-push.js";
import { TreehouseWorktreeManager } from "../adapters/treehouse.js";
import { TaskStore } from "../storage/task-store.js";
import { FirstmateDeliveryWorkflow } from "../workflows/firstmate-delivery.js";
import { GitHubDraftPullRequestWorkflow } from "../workflows/github-draft-pr.js";
import { GitHubMergeWorkflow } from "../workflows/github-merge.js";
import { GitHubStatusWorkflow } from "../workflows/github-status.js";
import { ExactHeadPushWorkflow } from "../workflows/git-push.js";
import { PostMergeAssuranceWorkflow } from "../workflows/post-merge-assurance.js";
import { TreehouseLedgerWorkflow } from "../workflows/treehouse-ledger.js";

export async function runFirstmateDeliveryCli({
  args,
  env = process.env,
  cwd = process.cwd(),
  write = (value) => console.log(value),
  workflow = null,
} = {}) {
  if (!Array.isArray(args)) throw new TypeError("args must be an array");
  const [command, ...values] = args;
  const delivery = workflow || createWorkflow({ env, cwd });
  let result;
  switch (command) {
    case "status":
      exactArguments(command, values, 1);
      result = await delivery.status({ taskId: values[0] });
      break;
    case "approve-push":
      exactArguments(command, values, 2);
      result = await delivery.approvePush({
        taskId: values[0],
        approvalId: values[1],
        humanActor: requireHumanActor(env),
      });
      break;
    case "push":
      exactArguments(command, values, 3);
      result = await delivery.push({
        taskId: values[0], operationId: values[1], approvalId: values[2],
      });
      break;
    case "reconcile-push":
      exactArguments(command, values, 2);
      result = await delivery.reconcilePush({
        taskId: values[0], operationId: values[1],
      });
      break;
    case "approve-pr": {
      exactArguments(command, values, 5);
      const [taskId, approvalId, baseBranch, titleFile, bodyFile] = values;
      const { title, body } = await readContent({ cwd, titleFile, bodyFile });
      result = await delivery.approveDraftPullRequest({
        taskId,
        approvalId,
        humanActor: requireHumanActor(env),
        baseBranch,
        title,
        body,
      });
      break;
    }
    case "create-pr": {
      atLeastArguments(command, values, 6);
      const [
        taskId, operationId, approvalId, baseBranch, titleFile, bodyFile,
        ...requiredChecks
      ] = values;
      const { title, body } = await readContent({ cwd, titleFile, bodyFile });
      result = await delivery.createDraftPullRequestAndObserveCi({
        taskId,
        operationId,
        approvalId,
        baseBranch,
        title,
        body,
        requiredChecks,
      });
      break;
    }
    case "reconcile-pr":
      exactArguments(command, values, 2);
      result = await delivery.reconcileDraftPullRequest({
        taskId: values[0], operationId: values[1],
      });
      break;
    case "ci":
      atLeastArguments(command, values, 2);
      result = await delivery.observeCi({
        taskId: values[0],
        operationId: values[1],
        requiredChecks: values.slice(2),
      });
      break;
    case "approve-merge":
      exactArguments(command, values, 2);
      result = await delivery.approveMerge({
        taskId: values[0],
        approvalId: values[1],
        humanActor: requireHumanActor(env),
      });
      break;
    case "merge":
      exactArguments(command, values, 3);
      result = await delivery.merge({
        taskId: values[0], operationId: values[1], approvalId: values[2],
      });
      break;
    case "reconcile-merge":
      exactArguments(command, values, 2);
      result = await delivery.reconcileMerge({
        taskId: values[0], operationId: values[1],
      });
      break;
    case "post-merge":
      exactArguments(command, values, 2);
      result = await delivery.completePostMerge({
        taskId: values[0], operationId: values[1],
      });
      break;
    case "reconcile-return":
      exactArguments(command, values, 1);
      result = await delivery.reconcileTreehouseReturn({ taskId: values[0] });
      break;
    default:
      usage();
  }
  write(JSON.stringify(result, null, 2));
  return result;
}

function createWorkflow({ env, cwd }) {
  const store = new TaskStore({
    rootDir: path.resolve(cwd, env.SHIPMATES_STATE_DIR || ".shipmates"),
  });
  const readGateway = new GitHubReadGateway();
  const actor = env.SHIPMATES_ACTOR || "firstmate";
  const statusWorkflow = new GitHubStatusWorkflow({ store, gateway: readGateway, actor });
  const treehouseWorkflow = new TreehouseLedgerWorkflow({
    store,
    manager: new TreehouseWorktreeManager(),
    actor,
  });
  const mergeWorkflow = new GitHubMergeWorkflow({
    store,
    readGateway,
    statusWorkflow,
    mergeGateway: new GitHubMergeGateway(),
    actor,
  });
  return new FirstmateDeliveryWorkflow({
    store,
    pushWorkflow: new ExactHeadPushWorkflow({
      store,
      pushAdapter: new ExactHeadGitPushAdapter(),
      readGateway,
      actor,
    }),
    draftWorkflow: new GitHubDraftPullRequestWorkflow({
      store,
      readGateway,
      writeGateway: new GitHubDraftPullRequestGateway(),
      statusWorkflow,
      actor,
    }),
    mergeWorkflow,
    postMergeWorkflow: new PostMergeAssuranceWorkflow({
      store,
      readGateway,
      treehouseWorkflow,
      actor,
    }),
  });
}

async function readContent({ cwd, titleFile, bodyFile }) {
  return {
    title: (await readFile(path.resolve(cwd, titleFile), "utf8")).trim(),
    body: await readFile(path.resolve(cwd, bodyFile), "utf8"),
  };
}

function requireHumanActor(env) {
  if (!env.SHIPMATES_HUMAN_ACTOR) {
    throw new Error("approval requires SHIPMATES_HUMAN_ACTOR");
  }
  return env.SHIPMATES_HUMAN_ACTOR;
}

function exactArguments(command, values, count) {
  if (values.length !== count || values.some((value) => !value)) {
    throw new Error(`${command} requires exactly ${count} arguments`);
  }
}

function atLeastArguments(command, values, count) {
  if (values.length < count || values.slice(0, count).some((value) => !value)) {
    throw new Error(`${command} requires at least ${count} arguments`);
  }
}

function usage() {
  throw new Error(
    "Usage: firstmate --delivery status TASK | approve-push TASK APPROVAL | push TASK OPERATION APPROVAL | reconcile-push TASK OPERATION | approve-pr TASK APPROVAL BASE TITLE_FILE BODY_FILE | create-pr TASK OPERATION APPROVAL BASE TITLE_FILE BODY_FILE [REQUIRED_CHECK ...] | reconcile-pr TASK OPERATION | ci TASK OPERATION [REQUIRED_CHECK ...] | approve-merge TASK APPROVAL | merge TASK OPERATION APPROVAL | reconcile-merge TASK OPERATION | post-merge TASK OPERATION | reconcile-return TASK",
  );
}
