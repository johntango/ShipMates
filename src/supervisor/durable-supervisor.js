export class DurableSupervisor {
  constructor({ reconcile, observe, advance, project, scheduler } = {}) {
    for (const [name, value] of Object.entries({ reconcile, observe, advance, project })) {
      if (typeof value !== "function") throw new TypeError(`DurableSupervisor requires ${name}`);
    }
    if (!scheduler || typeof scheduler.start !== "function" || typeof scheduler.cancel !== "function") {
      throw new TypeError("DurableSupervisor requires a cancellable scheduler");
    }
    this.reconcile = reconcile;
    this.observe = observe;
    this.advance = advance;
    this.project = project;
    this.scheduler = scheduler;
    this.clients = new Set();
    this.started = false;
    this.activeRun = null;
    this.startPromise = null;
    this.lifecycleRevision = 0;
  }

  async start() {
    if (this.started) return this.snapshot();
    if (this.startPromise) return this.startPromise;
    const revision = ++this.lifecycleRevision;
    const start = (async () => {
      const result = await this.runOnce("startup");
      if (revision !== this.lifecycleRevision) return result.snapshot;
      this.scheduler.start();
      this.started = true;
      return result.snapshot;
    })();
    this.startPromise = start;
    try { return await start; }
    finally { if (this.startPromise === start) this.startPromise = null; }
  }

  async stop() {
    this.lifecycleRevision += 1;
    this.started = false;
    await this.scheduler.cancel();
    await Promise.allSettled([this.startPromise]);
    await this.scheduler.cancel();
    await Promise.allSettled([this.activeRun]);
    this.clients.clear();
  }

  async runOnce(trigger = "scheduled") {
    if (this.activeRun) return this.activeRun;
    const run = this.#run(trigger);
    this.activeRun = run;
    try { return await run; }
    finally { if (this.activeRun === run) this.activeRun = null; }
  }

  async connect(client) {
    if (!client || typeof client.send !== "function") {
      throw new TypeError("Supervisor clients require send(snapshot)");
    }
    this.clients.add(client);
    await Promise.allSettled([this.snapshot().then((snapshot) => client.send(snapshot))]);
    return () => this.clients.delete(client);
  }

  async snapshot() { return this.project(); }

  async #run(trigger) {
    const observations = await this.observe();
    const decisions = await this.reconcile({ trigger, observations });
    const advancement = await this.advance({ trigger, observations, decisions });
    const snapshot = await this.project({ trigger, observations, decisions, advancement });
    await Promise.allSettled([...this.clients].map((client) =>
      Promise.resolve().then(() => client.send(snapshot))));
    return { trigger, observations, decisions, advancement, snapshot };
  }
}

export function createSupervisorTask(supervisor) {
  if (!supervisor || typeof supervisor.runOnce !== "function") {
    throw new TypeError("Supervisor task requires a DurableSupervisor");
  }
  return () => supervisor.runOnce("scheduled");
}
