// Structured file logger for remote-acpx extension diagnostics.
// Writes to /tmp/remote-acpx.log, readable via /debug/cli endpoint.
// Survives across plugin reloads; cleared on container restart (/tmp).

import { appendFileSync } from "node:fs";

const LOG_PATH = "/tmp/remote-acpx.log";

function write(level: string, msg: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [${level}] ${msg}\n`);
  } catch {
    // Best-effort — /tmp may be unavailable in some environments
  }
}

export const log = {
  info: (msg: string) => write("INFO", msg),
  warn: (msg: string) => write("WARN", msg),
  error: (msg: string) => write("ERROR", msg),
};
