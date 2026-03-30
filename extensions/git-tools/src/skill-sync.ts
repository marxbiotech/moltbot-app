import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { reposDir } from "./shared.ts";

function skillsDir(): string {
  const home = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
  return path.join(home, "workspace", "skills");
}

function syncOneSkill(src: string, dstDir: string, name: string): string {
  const link = path.join(dstDir, name);

  if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) {
    const existing = fs.readlinkSync(link);
    if (existing === src) return `${name}: already synced`;
    fs.unlinkSync(link);
  } else if (fs.existsSync(link)) {
    return `${name}: exists as non-symlink, skipping (remove manually to re-sync)`;
  }

  fs.symlinkSync(src, link);
  return `${name}: synced -> ${src}`;
}

export const skillSyncTool = {
  name: "skill_sync",
  description:
    "Sync skills from a git repo in the workspace to the openclaw skills directory. " +
    "Skills are symlinked so they stay in sync with git pulls. " +
    "Use action 'list' to see installed skills, 'sync' to install from a repo path, 'remove' to unlink a skill.",
  parameters: Type.Object({
    action: Type.Union([Type.Literal("list"), Type.Literal("sync"), Type.Literal("remove")], {
      description: "Action to perform",
    }),
    path: Type.Optional(
      Type.String({
        description:
          "For sync: repo-relative path to skills directory, e.g. 'moltbot-env/skills'. " +
          "For remove: skill name to remove.",
      }),
    ),
  }),
  async execute(params: { action: "list" | "sync" | "remove"; path?: string }): Promise<string> {
    const dst = skillsDir();
    const repos = reposDir();

    if (params.action === "list") {
      if (!fs.existsSync(dst)) return "No skills directory found.";
      const entries = fs.readdirSync(dst, { withFileTypes: true });
      const skills = entries.filter((e) => {
        const full = path.join(dst, e.name);
        const isDir = e.isDirectory() || (e.isSymbolicLink() && fs.statSync(full).isDirectory());
        return isDir && fs.existsSync(path.join(full, "SKILL.md"));
      });
      if (skills.length === 0) return "No skills installed.";
      return skills
        .map((s) => {
          const full = path.join(dst, s.name);
          if (fs.lstatSync(full).isSymbolicLink()) {
            return `${s.name} -> ${fs.readlinkSync(full)}`;
          }
          return `${s.name} (local)`;
        })
        .join("\n");
    }

    if (params.action === "remove") {
      if (!params.path) return "Error: skill name required for remove";
      const link = path.join(dst, params.path);
      if (!fs.existsSync(link)) return `Skill '${params.path}' not found.`;
      if (!fs.lstatSync(link).isSymbolicLink()) {
        return `'${params.path}' is not a symlinked skill. Remove manually if needed.`;
      }
      fs.unlinkSync(link);
      return `Removed skill '${params.path}'.`;
    }

    // sync
    if (!params.path) return "Error: path required for sync, e.g. 'moltbot-env/skills'";
    const srcPath = path.resolve(repos, params.path);
    if (!srcPath.startsWith(repos)) return "Error: path must be under workspace repos.";
    if (!fs.existsSync(srcPath)) {
      const available = fs.existsSync(repos) ? fs.readdirSync(repos).join(", ") : "none";
      return `Path not found: ${srcPath}\nAvailable repos: ${available}`;
    }

    fs.mkdirSync(dst, { recursive: true });
    const results: string[] = [];

    if (fs.existsSync(path.join(srcPath, "SKILL.md"))) {
      // Single skill
      results.push(syncOneSkill(srcPath, dst, path.basename(srcPath)));
    } else {
      // Directory of skills
      const children = fs.readdirSync(srcPath, { withFileTypes: true });
      const skillDirs = children.filter(
        (c) => c.isDirectory() && fs.existsSync(path.join(srcPath, c.name, "SKILL.md")),
      );
      if (skillDirs.length === 0) {
        return `No skills found under ${params.path} (no SKILL.md in subdirectories).`;
      }
      for (const s of skillDirs) {
        results.push(syncOneSkill(path.join(srcPath, s.name), dst, s.name));
      }
    }

    return results.join("\n");
  },
};
