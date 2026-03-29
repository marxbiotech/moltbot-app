import os from "node:os";
import fs from "node:fs";

interface CheckResult {
  text: string;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}Gi`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)}Mi`;
  return `${(bytes / 1024).toFixed(0)}Ki`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(" ");
}

export function sysInfo(): CheckResult {
  const lines: string[] = [];
  let warns = 0;

  const info = (msg: string) => lines.push(`[INFO] ${msg}`);
  const warn = (msg: string) => {
    lines.push(`[WARN] ${msg}`);
    warns++;
  };

  info(`Hostname: ${os.hostname()}`);
  info(`Kernel: ${os.release()}`);
  info(`Uptime: ${formatUptime(os.uptime())}`);

  // Memory
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  info(`Memory: ${formatBytes(usedMem)} used / ${formatBytes(totalMem)} total (${formatBytes(freeMem)} available)`);

  // Disk
  try {
    const stat = fs.statfsSync("/");
    const total = stat.blocks * stat.bsize;
    const avail = stat.bavail * stat.bsize;
    const used = total - avail;
    const pct = total > 0 ? Math.round((used / total) * 100) : 0;
    const msg = `Disk: ${formatBytes(used)} used, ${formatBytes(avail)} available (${pct}%)`;
    if (pct > 90) {
      warn(msg);
    } else {
      info(msg);
    }
  } catch {
    warn("Disk: unable to read filesystem stats");
  }

  lines.push("");
  lines.push("--- System Info ---");
  if (warns > 0) lines.push(`${warns} warning(s)`);

  return { text: lines.join("\n") };
}
