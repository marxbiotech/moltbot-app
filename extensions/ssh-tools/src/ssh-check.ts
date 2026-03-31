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
  return path.join(os.homedir(), ".ssh");
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

  // 1. SSH directory exists
  if (!fs.existsSync(dir)) {
    fail(`SSH directory missing: ${dir}`);
    lines.push("");
    lines.push("Run /ssh_setup to initialize SSH keys, or configure a K8s Secret mount.");
    lines.push("");
    lines.push(`--- SSH Check: ${passes} PASS / ${warns} WARN / ${fails} FAIL ---`);
    return { text: lines.join("\n") };
  }

  // 2. Detect provisioning method (subPath mount makes the file read-only, dir stays writable)
  let keyIsReadOnly = false;
  if (fs.existsSync(keyPath)) {
    try {
      fs.accessSync(keyPath, fs.constants.W_OK);
    } catch {
      keyIsReadOnly = true;
    }
  }
  info(`Source: ${keyIsReadOnly ? "K8s Secret mount (read-only key)" : "local filesystem"}`);

  // 3. Private key
  if (fs.existsSync(keyPath)) {
    const keyMode = fileMode(keyPath);
    if (keyMode === 0o600 || (keyIsReadOnly && keyMode !== null)) {
      pass(`Private key: present (${keyMode!.toString(8)})`);
    } else if (keyMode !== null) {
      warn(`Private key permissions: ${keyMode.toString(8)} (expected 600)`);
    }
  } else {
    fail(`Private key: missing (${keyPath})`);
  }

  // 4. Public key (optional — K8s Secret may only mount private key)
  if (fs.existsSync(pubPath)) {
    pass("Public key: present");
  } else {
    info("Public key: not present");
  }

  // 5. known_hosts
  const hasGithub = fs.existsSync(knownHostsPath) &&
    fs.readFileSync(knownHostsPath, "utf8").includes("github.com");
  if (hasGithub) {
    pass("known_hosts: contains github.com");
  } else {
    warn("known_hosts: missing github.com (run /ssh_setup to add)");
  }

  // 6. Key fingerprint
  if (fs.existsSync(pubPath)) {
    try {
      const { stdout } = await execFilePromise("ssh-keygen", ["-lf", pubPath], 5_000);
      info(`Key fingerprint: ${stdout.trim()}`);
    } catch {
      // silently skip if ssh-keygen not available
    }
  } else if (fs.existsSync(keyPath)) {
    // Extract fingerprint from private key
    try {
      const { stdout } = await execFilePromise("ssh-keygen", ["-lf", keyPath], 5_000);
      info(`Key fingerprint: ${stdout.trim()}`);
    } catch {
      // silently skip
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
