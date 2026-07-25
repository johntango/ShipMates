#!/usr/bin/env node
import path from "node:path";

import { parseDoctorArgs, renderDoctorReport } from "../src/cli/doctor.js";
import { ShipMatesDoctor } from "../src/doctor/system-doctor.js";
import { SystemDoctorObserver } from "../src/doctor/system-observer.js";
import { ProjectStore } from "../src/projects/project-store.js";
import { TaskStore } from "../src/storage/task-store.js";

const [command, ...args] = process.argv.slice(2);
if (command !== "doctor") {
  console.error("Usage: shipmates doctor [--project PROJECT] [--task TASK] [--json]");
  process.exitCode = 2;
} else {
  try {
    const options = parseDoctorArgs(args);
    const rootDir = path.resolve(process.env.SHIPMATES_STATE_DIR || path.join(process.cwd(), ".shipmates"));
    const report = await new ShipMatesDoctor({
      projectStore: new ProjectStore({ rootDir }),
      taskStore: new TaskStore({ rootDir }),
      observer: new SystemDoctorObserver(),
    }).inspect(options);
    console.log(options.json ? JSON.stringify(report, null, 2) : renderDoctorReport(report));
    if (!report.clean) process.exitCode = 1;
  } catch (error) {
    console.error(`shipmates doctor failed: ${error.message}`);
    process.exitCode = 2;
  }
}
