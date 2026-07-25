#!/usr/bin/env node
import path from "node:path";

import { parseDoctorArgs, renderDoctorReport } from "../src/cli/doctor.js";
import { ShipMatesDoctor } from "../src/doctor/system-doctor.js";
import { SystemDoctorObserver } from "../src/doctor/system-observer.js";
import { parseInvariantArgs, renderInvariantReport } from "../src/cli/invariants.js";
import { ProjectStore } from "../src/projects/project-store.js";
import { StateInvariantChecker } from "../src/state/invariant-checker.js";
import { TaskStore } from "../src/storage/task-store.js";

const [command, ...args] = process.argv.slice(2);
if (!new Set(["doctor", "invariants"]).has(command)) {
  console.error("Usage: shipmates <doctor|invariants> [options]");
  process.exitCode = 2;
} else {
  try {
    const rootDir = path.resolve(process.env.SHIPMATES_STATE_DIR || path.join(process.cwd(), ".shipmates"));
    const projectStore = new ProjectStore({ rootDir });
    const taskStore = new TaskStore({ rootDir });
    const options = command === "doctor" ? parseDoctorArgs(args) : parseInvariantArgs(args);
    const report = command === "doctor"
      ? await new ShipMatesDoctor({ projectStore, taskStore, observer: new SystemDoctorObserver() }).inspect(options)
      : await new StateInvariantChecker({ rootDir, projectStore, taskStore }).inspect();
    const rendered = command === "doctor" ? renderDoctorReport(report) : renderInvariantReport(report);
    console.log(options.json ? JSON.stringify(report, null, 2) : rendered);
    if (!report.clean) process.exitCode = 1;
  } catch (error) {
    console.error(`shipmates ${command} failed: ${error.message}`);
    process.exitCode = 2;
  }
}
