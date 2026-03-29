import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

export function reposDir(): string {
  const home = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
  return path.join(home, "workspace", "repos");
}

export function git(args: string[], cwd?: string, timeoutMs = 15_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/** Find all git repos under a root directory (up to maxDepth levels). */
export function findRepos(root: string, maxDepth = 3): string[] {
  const repos: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === ".git") {
        repos.push(dir);
        return; // don't recurse into .git
      }
      walk(full, depth + 1);
    }
  }
  walk(root, 0);
  return repos;
}
