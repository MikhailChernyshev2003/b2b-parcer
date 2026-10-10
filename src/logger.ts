type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const envLevel = (process.env.LOG_LEVEL as Level) || "info";
const threshold = LEVELS[envLevel] ?? LEVELS.info;

function ts(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

type Sink = (line: string) => void;
const sinks = new Set<Sink>();

/** Subscribe to formatted log lines (used by the web UI job log). Returns unsubscribe. */
export function subscribeLog(sink: Sink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

function log(level: Level, ...args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const prefix = `[${ts()}] ${level.toUpperCase().padEnd(5)}`;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(prefix, ...args);
  if (sinks.size) {
    const line = `${prefix} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
    for (const s of sinks) {
      try {
        s(line);
      } catch {
        /* ignore sink errors */
      }
    }
  }
}

export const logger = {
  debug: (...a: unknown[]) => log("debug", ...a),
  info: (...a: unknown[]) => log("info", ...a),
  warn: (...a: unknown[]) => log("warn", ...a),
  error: (...a: unknown[]) => log("error", ...a),
};
