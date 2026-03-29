import fs from "node:fs";
import path from "node:path";
import { git, reposDir, findRepos } from "./shared.ts";

interface CheckResult {
  text: string;
}

const URL_RE = /^(git@|https:\/\/|ssh:\/\/)/;

export async function gitSync(argsStr?: string): Promise<CheckResult> {
  const lines: string[] = [];
  let passes = 0;
  let warns = 0;
  let fails = 0;

  const pass = (msg: string) => { lines.push(`[PASS] ${msg}`); passes++; };
  const warn = (msg: string) => { lines.push(`[WARN] ${msg}`); warns++; };
  const fail = (msg: string) => { lines.push(`[FAIL] ${msg}`); fails++; };
  const info = (msg: string) => { lines.push(`[INFO] ${msg}`); };

  // Set global pull.rebase
  try {
    await git(["config", "--global", "pull.rebase", "true"]);
    pass("git config: pull.rebase = true");
  } catch {
    warn("git config: failed to set pull.rebase");
  }

  const root = reposDir();
  const parts = argsStr?.split(/\s+/).filter(Boolean) ?? [];

  if (parts.length > 0) {
    // Mode: clone/pull a specific repo
    const url = parts[0];
    if (!URL_RE.test(url)) {
      fail(`Invalid URL format: ${url} (must start with git@, https://, or ssh://)`);
      lines.push("");
      lines.push(`--- Git Sync: ${passes} PASS / ${warns} WARN / ${fails} FAIL ---`);
      return { text: lines.join("\n") };
    }

    const repoName = parts[1] ?? path.basename(url, ".git");
    const target = path.join(root, repoName);

    if (fs.existsSync(path.join(target, ".git"))) {
      // Repo exists — pull
      info(`Repo already exists: ${target}`);
      try {
        const { stdout: status } = await git(["status", "--porcelain"], target);
        if (status.trim()) {
          warn(`${repoName}: has uncommitted changes, skipping pull`);
        } else {
          try {
            const { stdout } = await git(["pull", "--rebase"], target, 60_000);
            if (stdout.includes("Already up to date")) {
              pass(`${repoName}: already up to date`);
            } else {
              const lastLine = stdout.trim().split("\n").pop() ?? "";
              pass(`${repoName}: pulled (${lastLine})`);
            }
          } catch (err: any) {
            const msg = (err.stdout ?? err.stderr ?? err.message ?? "").split("\n")[0];
            fail(`${repoName}: pull failed — ${msg}`);
          }
        }
      } catch {
        warn(`${repoName}: unable to check status`);
      }
    } else {
      // Clone
      fs.mkdirSync(path.dirname(target), { recursive: true });
      info(`Cloning ${url} -> ${target}`);
      try {
        await git(["clone", url, target], undefined, 60_000);
        pass(`${repoName}: cloned successfully`);
      } catch (err: any) {
        const msg = (err.stdout ?? err.stderr ?? err.message ?? "").split("\n")[0];
        fail(`${repoName}: clone failed — ${msg}`);
      }
    }
  } else {
    // Mode: pull all repos
    info(`Scanning ${root} for git repos...`);
    const repos = findRepos(root);

    if (repos.length === 0) {
      warn(`No git repos found in ${root}`);
      info("To clone a repo: /git_sync <git-url>");
    } else {
      info(`Found ${repos.length} repo(s)`);

      for (const repo of repos) {
        const name = path.basename(repo);
        try {
          const { stdout: status } = await git(["status", "--porcelain"], repo);
          if (status.trim()) {
            warn(`${name}: has uncommitted changes, skipping pull`);
          } else {
            try {
              const { stdout } = await git(["pull", "--rebase"], repo, 60_000);
              if (stdout.includes("Already up to date")) {
                pass(`${name}: already up to date`);
              } else {
                const lastLine = stdout.trim().split("\n").pop() ?? "";
                pass(`${name}: pulled (${lastLine})`);
              }
            } catch (err: any) {
              const msg = (err.stdout ?? err.stderr ?? err.message ?? "").split("\n")[0];
              fail(`${name}: pull failed — ${msg}`);
            }
          }
        } catch {
          warn(`${name}: unable to check status`);
        }
      }
    }
  }

  lines.push("");
  lines.push(`--- Git Sync: ${passes} PASS / ${warns} WARN / ${fails} FAIL ---`);

  return { text: lines.join("\n") };
}
