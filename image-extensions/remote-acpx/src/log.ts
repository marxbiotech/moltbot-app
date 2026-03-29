// Structured file logger for remote-acpx extension diagnostics.
// Writes to /tmp/remote-acpx.log. Can be read via sandbox exec (e.g., /debug/cli?cmd=cat+/tmp/remote-acpx.log).
// Survives across plugin reloads; cleared on container restart (/tmp).

import { appendFileSync } from "node:fs";

const LOG_PATH = "/tmp/remote-acpx.log";

function write(level: string, msg: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  try {
    appendFileSync(LOG_PATH, line + "\n");
  } catch {
    console.error(`[remote-acpx] ${line}`);
  }
}

export const log = {
  info: (msg: string) => write("INFO", msg),
  warn: (msg: string) => write("WARN", msg),
  error: (msg: string) => write("ERROR", msg),
};
