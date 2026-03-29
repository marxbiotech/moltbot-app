import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

interface CheckResult {
  text: string;
}

function execFilePromise(cmd: string, args: string[], timeoutMs = 15_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

function sshDir(): string {
  const home = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
  return path.join(home, "workspace", ".ssh");
}

function fileMode(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return null;
  }
}

export async function sshCheck(): Promise<CheckResult> {
  const lines: string[] = [];
  let passes = 0;
  let warns = 0;
  let fails = 0;

  const pass = (msg: string) => { lines.push(`[PASS] ${msg}`); passes++; };
  const warn = (msg: string) => { lines.push(`[WARN] ${msg}`); warns++; };
  const fail = (msg: string) => { lines.push(`[FAIL] ${msg}`); fails++; };
  const info = (msg: string) => { lines.push(`[INFO] ${msg}`); };

  const dir = sshDir();
  const keyPath = path.join(dir, "id_ed25519");
  const pubPath = path.join(dir, "id_ed25519.pub");
  const knownHostsPath = path.join(dir, "known_hosts");
  const homeSsh = path.join(os.homedir(), ".ssh");

  // Early exit if workspace SSH dir doesn't exist
  if (!fs.existsSync(dir)) {
    fail(`SSH directory missing: ${dir}`);
    lines.push("");
    lines.push("Run /ssh_setup to initialize SSH keys.");
    lines.push("");
    lines.push(`--- SSH Check: ${passes} PASS / ${warns} WARN / ${fails} FAIL ---`);
    return { text: lines.join("\n") };
  }

  // 1. Symlink integrity
  try {
    const stat = fs.lstatSync(homeSsh);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(homeSsh);
      if (target === dir) {
        pass(`Symlink: ${homeSsh} -> ${dir}`);
      } else {
        warn(`Symlink: ${homeSsh} -> ${target} (expected ${dir})`);
      }
    } else if (stat.isDirectory()) {
      fail(`Symlink: ${homeSsh} is a real directory (keys will be lost on restart)`);
    }
  } catch {
    fail(`Symlink: ${homeSsh} does not exist`);
  }

  // 2. Directory permissions
  const dirMode = fileMode(dir);
  if (dirMode !== null) {
    if (dirMode === 0o700) {
      pass("Directory permissions: 700");
    } else {
      fail(`Directory permissions: ${dirMode.toString(8)} (should be 700)`);
    }
  } else {
    fail(`Directory missing: ${dir} (run /ssh_setup)`);
  }

  // 3. Private key permissions
  const keyMode = fileMode(keyPath);
  if (keyMode !== null) {
    if (keyMode === 0o600) {
      pass("Private key permissions: 600");
    } else {
      fail(`Private key permissions: ${keyMode.toString(8)} (should be 600)`);
    }
  } else {
    fail(`Private key: missing (${keyPath})`);
  }

  // 4. Public key permissions
  const pubMode = fileMode(pubPath);
  if (pubMode !== null) {
    if (pubMode === 0o644) {
      pass("Public key permissions: 644");
    } else {
      warn(`Public key permissions: ${pubMode.toString(8)} (recommended 644)`);
    }
  } else {
    fail(`Public key: missing (${pubPath})`);
  }

  // 5. known_hosts
  if (fs.existsSync(knownHostsPath)) {
    const content = fs.readFileSync(knownHostsPath, "utf8");
    if (content.includes("github.com")) {
      pass("known_hosts: contains github.com");
    } else {
      warn("known_hosts: exists but missing github.com entry");
    }
  } else {
    warn("known_hosts: missing (will get interactive prompt on first connect)");
  }

  // 6. Key fingerprint
  if (fs.existsSync(pubPath)) {
    try {
      const { stdout } = await execFilePromise("ssh-keygen", ["-lf", pubPath], 5_000);
      info(`Key fingerprint: ${stdout.trim()}`);
    } catch {
      // silently skip if ssh-keygen not available
    }
  }

  // 7. GitHub connectivity
  try {
    await execFilePromise("ssh", ["-T", "git@github.com", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes"]);
    pass("GitHub SSH: connected");
  } catch (err: any) {
    const output = ((err.stdout ?? "") + (err.stderr ?? "")).trim();
    if (output.includes("successfully authenticated")) {
      const match = output.match(/Hi ([^!]+)/);
      pass(`GitHub SSH: authenticated as ${match?.[1] ?? "unknown"}`);
    } else if (output.includes("Permission denied")) {
      fail("GitHub SSH: Permission denied (key not added to GitHub?)");
    } else {
      warn(`GitHub SSH: ${output.split("\n")[0]?.slice(0, 100)}`);
    }
  }

  lines.push("");
  lines.push(`--- SSH Check: ${passes} PASS / ${warns} WARN / ${fails} FAIL ---`);

  return { text: lines.join("\n") };
}
