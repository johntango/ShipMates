import path from "node:path";

import { HerdrProjection, renderHerdrView } from "../src/projections/herdr.js";
import { TaskStore } from "../src/storage/task-store.js";

const [command, ...args] = process.argv.slice(2);
if (!new Set(["json", "view"]).has(command) || args.length !== 1 || !args[0]) {
  throw new Error("Usage: herdr-status.js <json|view> TASK_ID");
}

const projector = new HerdrProjection({
  store: new TaskStore({
    rootDir: path.resolve(process.env.SHIPMATES_STATE_DIR || ".shipmates"),
  }),
});
const projection = await projector.read({ taskId: args[0] });
if (command === "json") {
  console.log(JSON.stringify(projection, null, 2));
} else {
  process.stdout.write(renderHerdrView(projection));
}
