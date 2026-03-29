import path from "node:path";
import { git, reposDir, findRepos } from "./shared.ts";

interface CheckResult {
  text: string;
}

export async function gitRepos(): Promise<CheckResult> {
  const lines: string[] = [];
  let passes = 0;
  let warns = 0;

  const root = reposDir();
  lines.push(`[INFO] Scanning ${root} for git repos...`);

  const repos = findRepos(root);

  if (repos.length === 0) {
    lines.push(`[WARN] No git repos found in ${root}`);
    lines.push("[INFO] To clone a repo: /git_sync <git-url>");
    warns++;
  } else {
    lines.push(`[INFO] Found ${repos.length} repo(s)`);
    lines.push("");

    for (const repo of repos) {
      const name = path.basename(repo);

      // Branch
      let branch = "detached";
      try {
        const { stdout } = await git(["branch", "--show-current"], repo);
        if (stdout.trim()) branch = stdout.trim();
      } catch {
        // keep detached
      }

      // Last commit
      let lastCommit = "";
      try {
        const { stdout } = await git(["log", "-1", "--format=%h %s"], repo);
        lastCommit = stdout.trim().slice(0, 60);
      } catch {
        // no commits
      }

      // Dirty status
      let dirty = false;
      let dirtyCount = 0;
      try {
        const { stdout } = await git(["status", "--porcelain"], repo);
        const dirtyLines = stdout.split("\n").filter(Boolean);
        dirty = dirtyLines.length > 0;
        dirtyCount = dirtyLines.length;
      } catch {
        // ignore
      }

      if (dirty) {
        lines.push(`[WARN] ${name}: branch=${branch} (${dirtyCount} uncommitted changes) — ${lastCommit}`);
        warns++;
      } else {
        lines.push(`[PASS] ${name}: branch=${branch} (clean) — ${lastCommit}`);
        passes++;
      }
    }
  }

  lines.push("");
  lines.push(`--- Git Repos: ${passes} PASS / ${warns} WARN ---`);

  return { text: lines.join("\n") };
}
