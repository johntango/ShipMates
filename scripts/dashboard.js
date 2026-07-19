import path from "node:path";

import { ShipMatesDashboardServer } from "../src/dashboard/server.js";
import { FirstmateProjectContext } from "../src/cli/firstmate-project-context.js";
import { TaskStore } from "../src/storage/task-store.js";
import { ProjectStore } from "../src/projects/project-store.js";

const store = new TaskStore({
  rootDir: path.resolve(process.env.SHIPMATES_STATE_DIR || ".shipmates"),
});
const server = new ShipMatesDashboardServer({
  store,
  projectContext: new FirstmateProjectContext({ store }),
  projectStore: new ProjectStore({ rootDir: store.rootDir }),
  onCommand: async () => {
    throw new Error("Standalone dashboard is read-only; start Firstmate to send commands");
  },
  port: Number(process.env.SHIPMATES_DASHBOARD_PORT || 4390),
});
console.log(`ShipMates dashboard: ${await server.start()}`);
