import type { MoltbotEnv } from '../types';

/**
 * Build environment variables to pass to the OpenClaw container process
 *
 * @param env - Worker environment bindings
 * @returns Environment variables record
 */
export function buildEnvVars(env: MoltbotEnv): Record<string, string> {
  const envVars: Record<string, string> = {};

  // Cloudflare AI Gateway configuration (new native provider)
  if (env.CLOUDFLARE_AI_GATEWAY_API_KEY) {
    envVars.CLOUDFLARE_AI_GATEWAY_API_KEY = env.CLOUDFLARE_AI_GATEWAY_API_KEY;
  }
  if (env.CF_AI_GATEWAY_ACCOUNT_ID) {
    envVars.CF_AI_GATEWAY_ACCOUNT_ID = env.CF_AI_GATEWAY_ACCOUNT_ID;
  }
  if (env.CF_AI_GATEWAY_GATEWAY_ID) {
    envVars.CF_AI_GATEWAY_GATEWAY_ID = env.CF_AI_GATEWAY_GATEWAY_ID;
  }

  // Direct provider keys
  if (env.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  if (env.OPENAI_API_KEY) envVars.OPENAI_API_KEY = env.OPENAI_API_KEY;
  if (env.GOOGLE_API_KEY) envVars.GOOGLE_API_KEY = env.GOOGLE_API_KEY;

  // Legacy AI Gateway support: AI_GATEWAY_BASE_URL + AI_GATEWAY_API_KEY
  // When set, these override direct keys for backward compatibility
  if (env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL) {
    const normalizedBaseUrl = env.AI_GATEWAY_BASE_URL.replace(/\/+$/, '');
    envVars.AI_GATEWAY_BASE_URL = normalizedBaseUrl;
    // Legacy path routes through Anthropic base URL
    envVars.ANTHROPIC_BASE_URL = normalizedBaseUrl;
    envVars.ANTHROPIC_API_KEY = env.AI_GATEWAY_API_KEY;
  } else if (env.ANTHROPIC_BASE_URL) {
    envVars.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL;
  }

  // Map MOLTBOT_GATEWAY_TOKEN to OPENCLAW_GATEWAY_TOKEN (container expects this name)
  if (env.MOLTBOT_GATEWAY_TOKEN) envVars.OPENCLAW_GATEWAY_TOKEN = env.MOLTBOT_GATEWAY_TOKEN;
  if (env.DEV_MODE) envVars.OPENCLAW_DEV_MODE = env.DEV_MODE;
  if (env.TELEGRAM_BOT_TOKEN) envVars.TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  if (env.TELEGRAM_DM_POLICY) envVars.TELEGRAM_DM_POLICY = env.TELEGRAM_DM_POLICY;
  if (env.TELEGRAM_WEBHOOK_SECRET) envVars.TELEGRAM_WEBHOOK_SECRET = env.TELEGRAM_WEBHOOK_SECRET;
  if (env.TELEGRAM_LIFECYCLE_CHAT_ID) envVars.TELEGRAM_LIFECYCLE_CHAT_ID = env.TELEGRAM_LIFECYCLE_CHAT_ID;
  if (env.DISCORD_BOT_TOKEN) envVars.DISCORD_BOT_TOKEN = env.DISCORD_BOT_TOKEN;
  if (env.DISCORD_DM_POLICY) envVars.DISCORD_DM_POLICY = env.DISCORD_DM_POLICY;
  if (env.SLACK_BOT_TOKEN) envVars.SLACK_BOT_TOKEN = env.SLACK_BOT_TOKEN;
  if (env.SLACK_APP_TOKEN) envVars.SLACK_APP_TOKEN = env.SLACK_APP_TOKEN;
  if (env.SLACK_SIGNING_SECRET) envVars.SLACK_SIGNING_SECRET = env.SLACK_SIGNING_SECRET;
  if (env.SLACK_DM_POLICY) envVars.SLACK_DM_POLICY = env.SLACK_DM_POLICY;
  if (env.DEFAULT_MODEL) envVars.DEFAULT_MODEL = env.DEFAULT_MODEL;
  if (env.CF_AI_GATEWAY_MODEL) envVars.CF_AI_GATEWAY_MODEL = env.CF_AI_GATEWAY_MODEL;
  if (env.CF_ACCOUNT_ID) envVars.CF_ACCOUNT_ID = env.CF_ACCOUNT_ID;
  if (env.CDP_SECRET) envVars.CDP_SECRET = env.CDP_SECRET;
  if (env.WORKER_URL) envVars.WORKER_URL = env.WORKER_URL;

  // AWS Bedrock MFA auth (used by aws_auth skill in container)
  // IMPORTANT: Pass as AWS_BASE_* to avoid colliding with AWS SDK credential chain.
  // AWS SDK reads AWS_ACCESS_KEY_ID automatically — if we pass the base IAM user creds
  // under that name, they override ~/.aws/credentials (where assumed-role creds live).
  if (env.AWS_ACCESS_KEY_ID) envVars.AWS_BASE_ACCESS_KEY_ID = env.AWS_ACCESS_KEY_ID;
  if (env.AWS_SECRET_ACCESS_KEY) envVars.AWS_BASE_SECRET_ACCESS_KEY = env.AWS_SECRET_ACCESS_KEY;
  if (env.AWS_MFA_SERIAL) envVars.AWS_MFA_SERIAL = env.AWS_MFA_SERIAL;
  if (env.AWS_ROLE_ARN) envVars.AWS_ROLE_ARN = env.AWS_ROLE_ARN;
  if (env.BEDROCK_DEFAULT_MODEL) envVars.BEDROCK_DEFAULT_MODEL = env.BEDROCK_DEFAULT_MODEL;
  if (env.MOLTBOT_EMAIL) envVars.MOLTBOT_EMAIL = env.MOLTBOT_EMAIL;

  // R2 persistence credentials (used by rclone in start-openclaw.sh)
  if (env.R2_ACCESS_KEY_ID) envVars.R2_ACCESS_KEY_ID = env.R2_ACCESS_KEY_ID;
  if (env.R2_SECRET_ACCESS_KEY) envVars.R2_SECRET_ACCESS_KEY = env.R2_SECRET_ACCESS_KEY;
  if (env.R2_BUCKET_NAME) envVars.R2_BUCKET_NAME = env.R2_BUCKET_NAME;

  // GitHub Apps credentials (decoded by start-openclaw.sh into ~/.github-apps/)
  if (env.GITHUB_APPS) envVars.GITHUB_APPS = env.GITHUB_APPS;

  // ACPX (Agent Control Protocol) configuration
  if (env.ACPX_ENABLED) envVars.ACPX_ENABLED = env.ACPX_ENABLED;
  if (env.ACPX_ALLOWED_AGENTS) envVars.ACPX_ALLOWED_AGENTS = env.ACPX_ALLOWED_AGENTS;
  if (env.CLAUDE_NODE_NAME) envVars.CLAUDE_NODE_NAME = env.CLAUDE_NODE_NAME;
  if (env.CLAUDE_NODE_WORKSPACE) envVars.CLAUDE_NODE_WORKSPACE = env.CLAUDE_NODE_WORKSPACE;
  if (env.CLAUDE_NODE_WORKSPACES) envVars.CLAUDE_NODE_WORKSPACES = env.CLAUDE_NODE_WORKSPACES;

  return envVars;
}
