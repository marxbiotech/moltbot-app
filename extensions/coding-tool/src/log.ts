// Structured file logger for coding-tool extension diagnostics.
// Writes to /tmp/coding-tool.log. Can be read via sandbox exec (e.g., /debug/cli?cmd=cat+/tmp/coding-tool.log).
// Survives across plugin reloads; cleared on container restart (/tmp).

import { appendFileSync } from "node:fs";

const LOG_PATH = "/tmp/coding-tool.log";

function write(level: string, msg: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  try {
    appendFileSync(LOG_PATH, line + "\n");
  } catch {
    console.error(`[coding-tool] ${line}`);
  }
}

export const log = {
  info: (msg: string) => write("INFO", msg),
  warn: (msg: string) => write("WARN", msg),
  error: (msg: string) => write("ERROR", msg),
};
