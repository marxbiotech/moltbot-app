import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface CheckResult {
  text: string;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}Gi`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)}Mi`;
  return `${(bytes / 1024).toFixed(0)}Ki`;
}

/**
 * Resolve the OpenClaw home directory.
 * Checks OPENCLAW_HOME, then falls back to ~/.openclaw.
 */
function openclawHome(): string {
  return process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
}

export function wsCheck(): CheckResult {
  const lines: string[] = [];
  let passes = 0;
  let warns = 0;
  let fails = 0;

  const pass = (msg: string) => { lines.push(`[PASS] ${msg}`); passes++; };
  const warn = (msg: string) => { lines.push(`[WARN] ${msg}`); warns++; };
  const fail = (msg: string) => { lines.push(`[FAIL] ${msg}`); fails++; };
  const info = (msg: string) => { lines.push(`[INFO] ${msg}`); };

  const home = openclawHome();

  // 1. Directory structure
  const dirs = [
    home,
    path.join(home, "skills"),
    path.join(home, "extensions"),
    path.join(home, "workspace"),
    path.join(home, "workspace", ".ssh"),
  ];
  for (const dir of dirs) {
    try {
      const stat = fs.statSync(dir);
      if (stat.isDirectory() || stat.isSymbolicLink()) {
        pass(`Directory: ${dir}`);
      } else {
        warn(`Not a directory: ${dir}`);
      }
    } catch {
      warn(`Directory missing: ${dir}`);
    }
  }

  // 2. openclaw.json validity
  const configPath = path.join(home, "openclaw.json");
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(raw);
    pass(`openclaw.json: valid JSON (${Buffer.byteLength(raw)} bytes)`);

    const gwPort = config.gateway?.port;
    if (gwPort) {
      pass(`Gateway config: port ${gwPort}`);
    } else {
      warn("Gateway config: port not set");
    }

    const channels = Object.keys(config.channels ?? {}).filter(
      (k) => config.channels[k]?.enabled,
    );
    if (channels.length > 0) {
      pass(`Channels: ${channels.join(", ")}`);
    } else {
      warn("Channels: none enabled");
    }

    const model = config.agents?.defaults?.model?.primary;
    info(`Model: ${model ?? "not set"}`);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      fail("openclaw.json: missing");
    } else if (err instanceof SyntaxError) {
      fail("openclaw.json: invalid JSON");
    } else {
      fail(`openclaw.json: ${err.message}`);
    }
  }

  // 3. Disk usage
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

  // 4. API key presence
  const keyMap: Record<string, string> = {
    ANTHROPIC_API_KEY: "Anthropic",
    OPENAI_API_KEY: "OpenAI",
    GOOGLE_API_KEY: "Google",
    CLOUDFLARE_AI_GATEWAY_API_KEY: "CF AI Gateway",
  };
  const found = Object.entries(keyMap)
    .filter(([env]) => process.env[env])
    .map(([, label]) => label);
  if (found.length > 0) {
    pass(`API keys: ${found.join(", ")}`);
  } else {
    fail("API keys: none found");
  }

  // 5. Gateway process
  try {
    const pidFile = path.join(home, "gateway.pid");
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    process.kill(pid, 0); // signal 0 = existence check
    pass("Gateway process: running");
  } catch {
    warn("Gateway process: not detected");
  }

  // 6. Installed skills & plugins
  for (const [kind, subdir] of [["skills", "skills"], ["plugins", "extensions"]] as const) {
    const dir = path.join(home, subdir);
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      if (entries.length > 0) {
        pass(`Installed ${kind} (${entries.length}): ${entries.join(", ")}`);
      } else {
        info(`Installed ${kind}: none`);
      }
    } catch {
      info(`Installed ${kind}: none`);
    }
  }

  lines.push("");
  lines.push(`--- Workspace Check: ${passes} PASS / ${warns} WARN / ${fails} FAIL ---`);

  return { text: lines.join("\n") };
}
