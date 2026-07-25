export function parseDoctorArgs(args) {
  const options = { project: null, task: null, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--project" || arg === "--task") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
    } else throw new Error(`Unknown doctor option: ${arg}`);
  }
  return options;
}

export function renderDoctorReport(report) {
  const lines = [
    `ShipMates doctor: ${report.clean ? "clean" : `${report.summary.findings} finding(s)`}`,
    `${report.summary.projects} project(s), ${report.summary.tasks} planned task(s) inspected read-only.`,
  ];
  for (const item of report.findings) {
    const subject = item.target.taskId || item.target.projectId || item.target.subject || "system";
    lines.push(`[${item.kind}] ${item.code} (${subject}): ${item.message}`);
    lines.push(`  Recovery: ${item.recovery.command || item.recovery.instruction}`);
  }
  return lines.join("\n");
}
