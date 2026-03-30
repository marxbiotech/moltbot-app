import { gitCheck } from "./src/git-check.ts";
import { gitSync } from "./src/git-sync.ts";
import { gitRepos } from "./src/git-repos.ts";
import { skillSyncTool } from "./src/skill-sync.ts";

export default function register(api: any) {
  api.registerCommand({
    name: "git_check",
    description: "Pre-push safety check (sensitive files, diff size, branch)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const args = ctx.args?.trim() || undefined;
      return gitCheck(args);
    },
  });

  api.registerCommand({
    name: "git_sync",
    description: "Pull all workspace repos or clone a new one by URL",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const args = ctx.args?.trim() || undefined;
      return gitSync(args);
    },
  });

  api.registerCommand({
    name: "git_repos",
    description: "Scan workspace git repos — branch and dirty status",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => gitRepos(),
  });

  api.registerTool(skillSyncTool);
}
