export class ProjectExecutionBackendRouter {
  constructor({ standard, persistent } = {}) {
    if (typeof standard !== "function" || typeof persistent !== "function") {
      throw new TypeError("ProjectExecutionBackendRouter requires standard and persistent backends");
    }
    this.standard = standard;
    this.persistent = persistent;
  }

  dispatch(input) {
    const mode = input.project?.executionPolicy?.mode === "persistent_project"
      ? "persistent" : "standard";
    return this[mode](input);
  }
}

export function createFirstmateProjectExecutionBackends({
  spawnProcess,
  processPath,
  firstmateScript,
  persistentScript,
  stateRoot,
  workingDirectory,
  projectTaskRuntime,
  hasProjectPane,
  environment = process.env,
} = {}) {
  if (typeof spawnProcess !== "function" || typeof hasProjectPane !== "function") {
    throw new TypeError("Firstmate execution backends require spawnProcess and hasProjectPane");
  }
  return new ProjectExecutionBackendRouter({
    persistent: ({ project, taskId, planTaskId, baseSha, instruction }) => {
      if (hasProjectPane(project.id)) {
        return projectTaskRuntime.dispatch({ project, planTaskId, taskId, baseSha, instruction });
      }
      const child = spawnProcess(processPath, [persistentScript, project.id, planTaskId, baseSha], {
        cwd: workingDirectory,
        env: { ...environment, SHIPMATES_STATE_DIR: stateRoot },
        stdio: ["pipe", "ignore", "inherit"],
      });
      child.stdin.end(`${instruction}\n`);
      return child;
    },
    standard: ({ taskId, requestId, context, instruction, projectParent,
      validationProfile, demoMode }) => {
      const child = spawnProcess(processPath, [
        firstmateScript, taskId, requestId, context.repo, context.baseSha,
      ], {
        cwd: context.repoPath,
        env: {
          ...environment,
          SHIPMATES_STATE_DIR: stateRoot,
          ...(projectParent ? { SHIPMATES_PROJECT_PARENT_TASK_ID: projectParent.id } : {}),
          SHIPMATES_VALIDATION_PROFILE: validationProfile,
          SHIPMATES_DEMO_MODE: demoMode ? "1" : "0",
        },
        stdio: ["pipe", "ignore", "inherit"],
      });
      child.stdin.end(`${instruction}\n`);
      return child;
    },
  });
}
