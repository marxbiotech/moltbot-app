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

export async function sshSetup(): Promise<CheckResult> {
  const lines: string[] = [];
  let passes = 0;
  let warns = 0;
  let fails = 0;

  const pass = (msg: string) => { lines.push(`[PASS] ${msg}`); passes++; };
  const warn = (msg: string) => { lines.push(`[WARN] ${msg}`); warns++; };
  const fail = (msg: string) => { lines.push(`[FAIL] ${msg}`); fails++; };

  const dir = sshDir();
  const keyPath = path.join(dir, "id_ed25519");
  const pubPath = path.join(dir, "id_ed25519.pub");
  const knownHostsPath = path.join(dir, "known_hosts");
  const keyComment = process.env.MOLTBOT_EMAIL ?? "openclaw-agent@github";

  // 1. Create workspace SSH directory
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);
  pass(`Created directory: ${dir} (700)`);

  // 2. Generate SSH key (skip if exists)
  if (fs.existsSync(keyPath)) {
    pass("SSH key already exists, skipping generation");
  } else {
    try {
      await execFilePromise("ssh-keygen", ["-t", "ed25519", "-C", keyComment, "-f", keyPath, "-N", ""]);
      pass("Generated new ed25519 key pair");
    } catch {
      fail("Failed to generate SSH key");
    }
  }

  // 3. Set permissions
  if (fs.existsSync(keyPath)) fs.chmodSync(keyPath, 0o600);
  if (fs.existsSync(pubPath)) fs.chmodSync(pubPath, 0o644);
  pass("Permissions set: private=600, public=644");

  // 4. Create/fix symlink (~/.ssh -> workspace .ssh)
  const homeSsh = path.join(os.homedir(), ".ssh");
  try {
    const stat = fs.lstatSync(homeSsh);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(homeSsh);
      if (target === dir) {
        pass(`Symlink already correct: ${homeSsh} -> ${dir}`);
      } else {
        fs.unlinkSync(homeSsh);
        fs.symlinkSync(dir, homeSsh);
        pass(`Symlink fixed: ${homeSsh} -> ${dir} (was ${target})`);
      }
    } else if (stat.isDirectory()) {
      fs.rmSync(homeSsh, { recursive: true });
      fs.symlinkSync(dir, homeSsh);
      pass(`Replaced real directory with symlink: ${homeSsh} -> ${dir}`);
    }
  } catch (err: any) {
    if (err.code === "ENOENT") {
      fs.symlinkSync(dir, homeSsh);
      pass(`Created symlink: ${homeSsh} -> ${dir}`);
    } else {
      warn(`Symlink: ${err.message}`);
    }
  }

  // 5. Configure known_hosts
  const hasGithub = fs.existsSync(knownHostsPath) &&
    fs.readFileSync(knownHostsPath, "utf8").includes("github.com");
  if (hasGithub) {
    pass("known_hosts: github.com already present");
  } else {
    try {
      const { stdout } = await execFilePromise("ssh-keyscan", ["github.com"], 10_000);
      fs.appendFileSync(knownHostsPath, stdout);
      pass("known_hosts: added github.com");
    } catch {
      warn("known_hosts: failed to scan github.com (network issue?)");
    }
  }

  // 6. Display public key
  lines.push("");
  if (fs.existsSync(pubPath)) {
    const pub = fs.readFileSync(pubPath, "utf8").trim();
    lines.push("=== PUBLIC KEY (add to GitHub: https://github.com/settings/ssh/new) ===");
    lines.push(pub);
    lines.push("=== END PUBLIC KEY ===");
  } else {
    warn("Public key file not found");
  }

  // 7. Test GitHub connectivity
  lines.push("");
  try {
    await execFilePromise("ssh", ["-T", "git@github.com", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes"]);
    pass("GitHub SSH: connected");
  } catch (err: any) {
    const output = ((err.stdout ?? "") + (err.stderr ?? "")).trim();
    if (output.includes("successfully authenticated")) {
      const match = output.match(/Hi ([^!]+)/);
      pass(`GitHub SSH: authenticated as ${match?.[1] ?? "unknown"}`);
    } else if (output.includes("Permission denied")) {
      warn("GitHub SSH: key not yet added to GitHub");
    } else {
      warn(`GitHub SSH: ${output.split("\n")[0]?.slice(0, 100)}`);
    }
  }

  lines.push("");
  lines.push(`--- SSH Setup: ${passes} PASS / ${warns} WARN / ${fails} FAIL ---`);

  return { text: lines.join("\n") };
}
