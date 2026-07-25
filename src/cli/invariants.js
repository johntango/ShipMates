export function parseInvariantArgs(args) {
  if (args.length === 0) return { json: false };
  if (args.length === 1 && args[0] === "--json") return { json: true };
  throw new Error("Usage: shipmates invariants [--json]");
}

export function renderInvariantReport(report) {
  const lines = [`ShipMates invariants: ${report.clean ? "clean" : `${report.summary.findings} finding(s)`}`];
  for (const item of report.findings) lines.push(`${item.code} (${item.target}): ${item.message}`);
  if (report.summary.truncated) lines.push("Inspection was truncated; rerun against a narrower state root.");
  return lines.join("\n");
}
