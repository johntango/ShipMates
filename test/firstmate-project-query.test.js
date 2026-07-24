import assert from "node:assert/strict";
import test from "node:test";

import {
  answerProjectQuery,
  enrichProjectBlockers,
  isExplicitProjectPlanningRequest,
  namedActionProject,
  parseDemoModeCommand,
  parseProjectBlockedCommand,
  parseProjectApproval,
  parseProjectCreation,
  parseProjectSelection,
} from "../src/cli/firstmate-project-query.js";

const projects = [{
  id: "project-a", name: "BallsA", repo: "owner/balls", repoPath: "/repos/balls",
  status: "approved", objective: "Bouncing red balls", tasks: [
    { id: "foundation", title: "Foundation", status: "completed", dependsOn: [] },
    { id: "animation", title: "Animation", status: "dispatched", dependsOn: ["foundation"] },
    { id: "polish", title: "Polish", status: "planned", dependsOn: ["animation"] },
  ],
}, {
  id: "project-b", name: "BallsB", repo: "owner/balls", repoPath: "/repos/balls",
  status: "paused", objective: "Bouncing blue balls", tasks: [],
}];

test("answers common project questions without a model turn", () => {
  assert.equal(answerProjectQuery("which is the selected project?", {
    activeProject: projects[0], projects,
  }), "The selected project is BallsA in owner/balls, located at /repos/balls.");

  const status = answerProjectQuery("give me a status report", {
    activeProject: projects[0], projects,
  });
  assert.match(status, /BallsA \(selected\): approved; 1\/3 tasks completed, 1 working, 2 remaining/u);
  assert.match(status, /BallsB: paused; no plan yet/u);
  assert.equal(answerProjectQuery("give me a status report on each project", {
    activeProject: projects[0], projects,
  }), status);
});

test("marks only the single active task in a named project as blocked", () => {
  const projects = [{
    id: "project-b", name: "TestB", objective: "Demo", tasks: [
      { id: "build", title: "Build", status: "completed" },
      { id: "validate", title: "Validate", status: "dispatched", taskId: "task-validate" },
    ],
  }];
  const command = parseProjectBlockedCommand(
    "Mark TestB as blocked because its task runner stalled without a result",
    projects,
  );
  assert.equal(command.project.id, "project-b");
  assert.equal(command.task.id, "validate");
  assert.equal(command.reason, "its task runner stalled without a result");
});

test("refuses an ambiguous project-level blocked command", () => {
  const projects = [{
    id: "project-b", name: "TestB", objective: "Demo", tasks: [
      { id: "one", title: "One", status: "claimed" },
      { id: "two", title: "Two", status: "dispatched" },
    ],
  }];
  const command = parseProjectBlockedCommand("Mark TestB blocked because stalled", projects);
  assert.equal(command.task, null);
  assert.equal(command.activeTaskCount, 2);
});

test("recognizes explicit planning boundaries that must fail closed", () => {
  assert.equal(isExplicitProjectPlanningRequest("Plan an accessible bouncing balls page"), true);
  assert.equal(isExplicitProjectPlanningRequest("Save a dependency-aware project plan and do not dispatch"), true);
  assert.equal(isExplicitProjectPlanningRequest("Create the web page now"), false);
});

test("renders named project task names and human statuses", () => {
  const answer = answerProjectQuery("show the next tasks for BallsA", {
    activeProject: projects[1], projects,
  });
  assert.match(answer, /Foundation: completed/u);
  assert.match(answer, /Animation: working/u);
  assert.doesNotMatch(answer, /project-a|task-/u);
});

test("names blocked work, explains evidence, suggests recovery, and shows next work", async () => {
  const source = structuredClone(projects);
  source[0].tasks[1].status = "blocked";
  source[0].tasks[1].taskId = "task-animation";
  source[0].tasks[2].dependsOn = ["does-not-exist"];
  const enriched = await enrichProjectBlockers(source, async () => ({
    validationRequests: [{ status: "requested" }], validationRuns: [], workers: [],
  }));
  const answer = answerProjectQuery("status for BallsA", {
    activeProject: enriched[0], projects: enriched,
  });
  assert.match(answer, /Blocked tasks:\n- BallsA — Animation: validation was interrupted/u);
  assert.match(answer, /Suggested solution for BallsA: ask Firstmate to reconcile/u);
  assert.match(answer, /No task in BallsA is dependency-ready/u);
});

test("identifies the next dependency-ready task", () => {
  const source = structuredClone(projects);
  source[0].tasks[2].dependsOn = [];
  const answer = answerProjectQuery("status for BallsA", {
    activeProject: source[0], projects: source,
  });
  assert.match(answer, /Next ready task for BallsA: Polish/u);
});

test("binds a recovery instruction to its one explicitly named project", () => {
  assert.equal(namedActionProject("Retry the blocked interface task for BallsA", projects)?.name, "BallsA");
  assert.equal(namedActionProject("Explain BallsA", projects), null);
  assert.equal(namedActionProject("Recover BallsA and BallsB", projects), null);
});

test("parses a project selection followed by another command", () => {
  const compound = parseProjectSelection(
    "Select BallsB, then start its next dependency-ready task",
    projects,
  );
  assert.equal(compound.project.name, "BallsB");
  assert.equal(compound.remainder, "start its next dependency-ready task");
  assert.deepEqual(parseProjectSelection("switch to BallsA", projects), {
    project: projects[0], remainder: "",
  });
  assert.deepEqual(parseProjectSelection("you can select BallsA", projects), {
    project: projects[0], remainder: "",
  });
  assert.deepEqual(parseProjectSelection("please select BallsB and start its next task", projects), {
    project: projects[1], remainder: "start its next task",
  });
  assert.deepEqual(parseProjectSelection("select Missing", projects), {
    project: null, remainder: "",
  });
});

test("parses bounded project creation names without retaining instruction prose", () => {
  assert.deepEqual(parseProjectCreation("Create project TestU"), {
    name: "TestU", repositoryQuery: null,
  });
  assert.deepEqual(parseProjectCreation("Create a new empty project under DemoTest3 called TestU"), {
    name: "TestU", repositoryQuery: "DemoTest3",
  });
  assert.deepEqual(parseProjectCreation("Create a new empty project named TestU under the DemoTest3 repository"), {
    name: "TestU", repositoryQuery: "DemoTest3",
  });
  assert.deepEqual(parseProjectCreation("Create TestA under DemoTest0"), {
    name: "TestA", repositoryQuery: "DemoTest0",
  });
});

test("binds natural demo-mode commands to one existing project", () => {
  const demoProjects = [...projects, { id: "project-u", name: "TestU" }];
  assert.equal(parseDemoModeCommand("make TestU a demo project", demoProjects).project.id, "project-u");
  assert.equal(parseDemoModeCommand("enable demo mode for TestU", demoProjects).project.id, "project-u");
  assert.equal(parseDemoModeCommand("make Missing a demo project", demoProjects).project, null);
});

test("binds natural plan approval to the durable selected project", () => {
  assert.equal(parseProjectApproval(
    "Approve the BallsA project plan and begin the first task", projects, projects[1],
  ).project.id, "project-a");
  assert.equal(parseProjectApproval(
    "Approve the plan and begin", projects, projects[0],
  ).project.id, "project-a");
  assert.equal(parseProjectApproval(
    "Approve the BallsA plan", projects, projects[0],
  ).project.id, "project-a");
  assert.equal(parseProjectApproval("Approve project Missing", projects).project, null);
});
