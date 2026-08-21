export const WORKFLOW_RUN_FEATURE_FLAG = "SHIPMATES_SIMPLE_WORKFLOW";

export function workflowRunEnabled(environment = process.env) {
  const value = environment[WORKFLOW_RUN_FEATURE_FLAG];
  return value === "1" || value === "true";
}
