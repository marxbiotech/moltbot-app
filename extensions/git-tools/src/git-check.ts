import os from "node:os";
import path from "node:path";
import { git, reposDir, findRepos } from "./shared.ts";

interface CheckResult {
  text: string;
}

const SENSITIVE_RE = /\.ssh\/|id_ed25519|id_rsa|id_ecdsa|\.env$|\.env\.|credentials|\.secret|SOUL\.md|IDENTITY\.md|\.pem$|\.key$/;

async function checkRepo(repoPath: string): Promise<{
  lines: string[];
  passes: number;
  warns: number;
  fails: number;
}> {
  const lines: string[] = [];
  let passes = 0;
  let warns = 0;
  let fails = 0;

  const pass = (msg: string) => { lines.push(`[PASS] ${msg}`); passes++; };
  const warn = (msg: string) => { lines.push(`[WARN] ${msg}`); warns++; };
  const fail = (msg: string) => { lines.push(`[FAIL] ${msg}`); fails++; };
  const info = (msg: string) => { lines.push(`[INFO] ${msg}`); };

  // 1. Verify git repository
  let repoRoot: string;
  try {
    const { stdout } = await git(["rev-parse", "--show-toplevel"], repoPath);
    repoRoot = stdout.trim();
  } catch {
    fail(`Not a git repository: ${repoPath}`);
    return { lines, passes, warns, fails };
  }

  // 2. Workspace root protection
  const home = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
  const workspace = path.join(home, "workspace");
  if (repoRoot === workspace || repoRoot === path.join(workspace, "repos")) {
    fail("Git repo at workspace root is forbidden! Repos must be in subdirectories.");
    return { lines, passes, warns, fails };
  }
  pass(`Repo location: ${repoRoot}`);

  // 3. Sensitive files detection
  const sensitiveFiles = new Set<string>();
  for (const args of [
    ["diff", "--cached", "--name-only"],
    ["diff", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    try {
      const { stdout } = await git(args, repoPath);
      for (const f of stdout.split("\n").filter(Boolean)) {
        if (SENSITIVE_RE.test(f)) sensitiveFiles.add(f);
      }
    } catch {
      // ignore
    }
  }

  if (sensitiveFiles.size > 0) {
    fail("Sensitive files detected:");
    for (const f of [...sensitiveFiles].sort()) {
      lines.push(`       ${f}`);
    }
  } else {
    pass("No sensitive files in changes");
  }

  // 4. Diff size
  try {
    const { stdout } = await git(["diff", "--cached", "--stat"], repoPath);
    const statLine = stdout.trim().split("\n").pop() ?? "";
    if (statLine.includes("changed")) {
      const filesChanged = statLine.match(/(\d+) file/)?.[1] ?? "0";
      const insertions = statLine.match(/(\d+) insertion/)?.[1] ?? "0";
      const deletions = statLine.match(/(\d+) deletion/)?.[1] ?? "0";
      const total = parseInt(insertions) + parseInt(deletions);
      const msg = `Diff size: ${filesChanged} files, +${insertions}/-${deletions} lines`;
      if (total > 1000) {
        warn(`${msg} (large diff)`);
      } else {
        pass(msg);
      }
    } else {
      info("Diff size: no staged changes");
    }
  } catch {
    info("Diff size: no staged changes");
  }

  // 5. Branch name
  try {
    const { stdout } = await git(["branch", "--show-current"], repoPath);
    const branch = stdout.trim();
    if (branch) {
      info(`Current branch: ${branch}`);
    } else {
      warn("Detached HEAD state");
    }
  } catch {
    warn("Detached HEAD state");
  }

  // 6. Unpushed commits
  try {
    const { stdout } = await git(["log", "@{u}..HEAD", "--oneline"], repoPath);
    const commits = stdout.trim().split("\n").filter(Boolean);
    if (commits.length > 0) {
      info(`Unpushed commits (${commits.length}):`);
      for (const c of commits.slice(0, 5)) {
        lines.push(`       ${c}`);
      }
      if (commits.length > 5) lines.push(`       ... and ${commits.length - 5} more`);
    } else {
      info("Unpushed commits: 0 (up to date with remote)");
    }
  } catch {
    info("Unpushed commits: no upstream tracking branch");
  }

  // 7. Divergence check
  try {
    const { stdout } = await git(["status", "-b", "--porcelain=v2"], repoPath);
    const abLine = stdout.split("\n").find((l) => l.startsWith("# branch.ab"));
    if (abLine) {
      const parts = abLine.split(/\s+/);
      const ahead = parseInt(parts[2]?.replace("+", "") ?? "0");
      const behind = parseInt(parts[3]?.replace("-", "") ?? "0");
      if (behind > 0) {
        warn(`Branch has diverged: +${ahead} ahead, -${behind} behind`);
      } else {
        pass("Branch not diverged from remote");
      }
    }
  } catch {
    // no upstream, skip
  }

  return { lines, passes, warns, fails };
}

export async function gitCheck(repoPathArg?: string): Promise<CheckResult> {
  const allLines: string[] = [];
  let totalPass = 0;
  let totalWarn = 0;
  let totalFail = 0;

  if (repoPathArg) {
    const result = await checkRepo(repoPathArg);
    allLines.push(...result.lines);
    totalPass += result.passes;
    totalWarn += result.warns;
    totalFail += result.fails;
  } else {
    const root = reposDir();
    const repos = findRepos(root);

    if (repos.length === 0) {
      allLines.push(`[WARN] No git repos found in ${root}`);
      allLines.push("[INFO] To clone a repo: /git_sync <git-url>");
      totalWarn++;
    } else {
      allLines.push(`[INFO] Checking ${repos.length} repo(s) in ${root}`);
      for (const repo of repos) {
        allLines.push("");
        allLines.push(`=== ${path.basename(repo)} ===`);
        const result = await checkRepo(repo);
        allLines.push(...result.lines);
        totalPass += result.passes;
        totalWarn += result.warns;
        totalFail += result.fails;
      }
    }
  }

  allLines.push("");
  allLines.push(`--- Git Check: ${totalPass} PASS / ${totalWarn} WARN / ${totalFail} FAIL ---`);
  if (totalFail > 0) allLines.push("PUSH NOT RECOMMENDED — resolve FAIL items first");

  return { text: allLines.join("\n") };
}
