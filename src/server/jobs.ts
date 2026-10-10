import { subscribeLog } from "../logger.js";

export type JobStatus = "idle" | "running" | "done" | "error";

export interface JobState {
  id: number;
  type: string;
  status: JobStatus;
  startedAt: string | null;
  finishedAt: string | null;
  log: string[];
  result: unknown;
  error: string | null;
}

const MAX_LOG = 500;

let current: JobState = {
  id: 0,
  type: "",
  status: "idle",
  startedAt: null,
  finishedAt: null,
  log: [],
  result: null,
  error: null,
};

export function getJob(): JobState {
  return current;
}

export function isRunning(): boolean {
  return current.status === "running";
}

/**
 * Start a background job. Only one job runs at a time. Logger output produced
 * during the run is captured into the job log for display in the UI.
 */
export function startJob(type: string, fn: () => Promise<unknown>): JobState {
  if (current.status === "running") return current;
  current = {
    id: current.id + 1,
    type,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    log: [],
    result: null,
    error: null,
  };
  const job = current;
  const unsubscribe = subscribeLog((line) => {
    job.log.push(line);
    if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
  });

  void (async () => {
    try {
      job.result = await fn();
      job.status = "done";
    } catch (err) {
      job.status = "error";
      job.error = (err as Error).message;
      job.log.push(`ОШИБКА: ${(err as Error).message}`);
    } finally {
      job.finishedAt = new Date().toISOString();
      unsubscribe();
    }
  })();

  return job;
}
