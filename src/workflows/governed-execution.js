import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeGovernedExecutionEnvelope({ stateRoot, envelope }) {
  const value = normalizeEnvelope(envelope);
  const directory = path.join(path.resolve(stateRoot), "governed-executions");
  const target = path.join(directory, `${value.requestId}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  return target;
}

export async function verifyGovernedExecutionEnvelope({ filePath, expected, projectStore }) {
  if (!filePath || !projectStore) throw new Error("Governed execution requires an envelope and project store");
  const value = normalizeEnvelope(JSON.parse(await readFile(path.resolve(filePath), "utf8")));
  for (const field of ["taskId", "requestId", "repo", "baseSha", "instruction", "authority"]) {
    if (value[field] !== expected[field]) throw new Error(`Governed execution envelope mismatches ${field}`);
  }
  const project = await projectStore.get(value.projectId);
  const task = project?.tasks.find(({ id }) => id === value.planTaskId);
  const attempt = task?.attempts?.find(({ taskId }) => taskId === value.taskId);
  if (!project || project.status !== "approved" || value.authority !== "local_write" ||
    !task || task.status !== "dispatched" || task.taskId !== value.taskId || !attempt) {
    throw new Error("Governed execution envelope is not bound to an approved dispatched plan task");
  }
  return value;
}

function normalizeEnvelope(value) {
  const fields = ["projectId", "planTaskId", "taskId", "requestId", "repo", "baseSha", "instruction", "authority"];
  if (!value || value.schemaVersion !== 1 ||
    fields.some((field) => typeof value[field] !== "string" || !value[field].trim()) ||
    value.authority !== "local_write") {
    throw new TypeError("Invalid governed execution envelope");
  }
  return Object.freeze({ schemaVersion: 1, ...Object.fromEntries(fields.map((field) => [field, value[field].trim()])) });
}
