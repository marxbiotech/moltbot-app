import { execFile } from "node:child_process";

/**
 * bedrock-auth plugin — /aws_auth MFA command for AWS Bedrock.
 *
 * Uses registerCommand() so the command executes WITHOUT the AI agent.
 * This is critical because /aws_auth bootstraps Bedrock credentials —
 * it must work before any LLM API key is available.
 *
 * The actual logic lives in /usr/local/bin/aws_auth
 * (installed by start-openclaw.sh from extensions/bedrock-auth/scripts/).
 */

function runScript(
  bin: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ text: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, env: process.env }, (err, stdout, stderr) => {
      const output = (stdout || "") + (stderr ? `\n${stderr}` : "");
      if (err && !output.trim()) {
        resolve({ text: `❌ ${bin} failed: ${err.message}` });
      } else {
        resolve({ text: output.trim() || "✅ Done." });
      }
    });
  });
}

export default function register(api: any) {
  api.registerCommand({
    name: "aws_auth",
    description: "Authenticate AWS Bedrock with MFA code",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const args = ctx.args?.trim();
      return runScript("aws_auth", args ? [args] : [], 30_000);
    },
  });
}
