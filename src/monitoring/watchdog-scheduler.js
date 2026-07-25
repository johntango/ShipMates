const DEFAULT_MONITOR_SECONDS = 15;
const MINIMUM_MONITOR_SECONDS = 5;

export function parseMonitorIntervalMs(value) {
  const parsed = value === undefined ? DEFAULT_MONITOR_SECONDS : Number(value);
  const seconds = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MONITOR_SECONDS;
  return Math.max(MINIMUM_MONITOR_SECONDS, seconds) * 1_000;
}

export function createWatchdogAudit({
  reconcile,
  terminalizeStale,
  inspect,
  onReconciliationError,
  onTerminalizationError,
  onInspectionError,
  onTerminalized,
  onAlert,
}) {
  return async function auditWatchdog() {
    try {
      await reconcile();
    } catch (error) {
      await onReconciliationError(error);
    }

    try {
      for (const result of await terminalizeStale()) await onTerminalized(result);
    } catch (error) {
      await onTerminalizationError(error);
    }

    try {
      for (const alert of await inspect()) await onAlert(alert);
    } catch (error) {
      await onInspectionError(error);
    }
  };
}

export class SerializedScheduler {
  constructor({
    task,
    intervalMs,
    onError,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    this.task = task;
    this.intervalMs = intervalMs;
    this.onError = onError;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.activeTask = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.#schedule();
  }

  async cancel() {
    this.running = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    await this.activeTask;
  }

  #schedule() {
    if (!this.running) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      const activeTask = this.#runScheduledTask();
      this.activeTask = activeTask;
      void activeTask.finally(() => {
        if (this.activeTask === activeTask) this.activeTask = null;
      });
    }, this.intervalMs);
  }

  async #runScheduledTask() {
    try {
      await this.task();
    } catch (error) {
      await this.onError(error);
    } finally {
      this.#schedule();
    }
  }
}

export async function runWithScheduler({ startupTask, scheduler, run }) {
  try {
    await startupTask();
    scheduler.start();
    return await run();
  } finally {
    await scheduler.cancel();
  }
}
