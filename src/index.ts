#!/usr/bin/env -S npx tsx
import { run } from "./cli.js";
import { logger } from "./logger.js";

run(process.argv.slice(2)).catch((err) => {
  logger.error((err as Error).stack || String(err));
  process.exit(1);
});
