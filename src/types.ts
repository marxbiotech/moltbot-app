import type { Sandbox } from '@cloudflare/sandbox';

/**
 * Webhook source identifier for queue message routing.
 */
export type WebhookSource = 'telegram' | 'slack';

/**
 * Queue message for webhook payloads (buffered via queue for at-least-once delivery).
 * A single queue handles all webhook sources; `source` determines delivery target.
 */
export interface WebhookQueueMessage {
  source: WebhookSource;
  rawBody: string;
  headers: Record<string, string>;
}

/**
 * Environment bindings for the Moltbot Worker
 */
export interface MoltbotEnv {
  Sandbox: DurableObjectNamespace<Sandbox>;
  ASSETS: Fetcher; // Assets binding for admin UI static files
  MOLTBOT_BUCKET: R2Bucket; // R2 bucket for persistent storage
  // Cloudflare AI Gateway configuration (preferred)
  CF_AI_GATEWAY_ACCOUNT_ID?: string; // Cloudflare account ID for AI Gateway
  CF_AI_GATEWAY_GATEWAY_ID?: string; // AI Gateway ID
  CLOUDFLARE_AI_GATEWAY_API_KEY?: string; // API key for requests through the gateway
  CF_AI_GATEWAY_MODEL?: string; // Override model: "provider/model-id" e.g. "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"
  // Legacy AI Gateway configuration (still supported for backward compat)
  AI_GATEWAY_API_KEY?: string; // API key for the provider configured in AI Gateway
  AI_GATEWAY_BASE_URL?: string; // AI Gateway URL (e.g., https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic)
  // Direct provider configuration
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  DEFAULT_MODEL?: string; // Default model override: "provider/model-id" e.g. "google/gemini-3-flash-preview"
  MOLTBOT_GATEWAY_TOKEN?: string; // Gateway token (mapped to OPENCLAW_GATEWAY_TOKEN for container)
  DEV_MODE?: string; // Set to 'true' for local dev (skips CF Access auth + openclaw device pairing)
  E2E_TEST_MODE?: string; // Set to 'true' for E2E tests (skips CF Access auth but keeps device pairing)
  DEBUG_ROUTES?: string; // Set to 'true' to enable /debug/* routes
  SANDBOX_SLEEP_AFTER?: string; // How long before sandbox sleeps: 'never' (default), or duration like '10m', '1h'
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_DM_POLICY?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;  // Secret for validating Telegram webhook requests
  TELEGRAM_LIFECYCLE_CHAT_ID?: string; // Bot owner chat ID for lifecycle notifications
  WEBHOOK_QUEUE?: Queue<WebhookQueueMessage>; // Unified queue for all webhook delivery (Telegram, Slack)
  /** @deprecated Use WEBHOOK_QUEUE — kept for backward compat during migration */
  TELEGRAM_QUEUE?: Queue<WebhookQueueMessage>;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_DM_POLICY?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;  // Signing secret for validating Slack HTTP Events API requests
  SLACK_DM_POLICY?: string;
  // AWS Bedrock MFA auth (zero standing privileges)
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_MFA_SERIAL?: string; // MFA device ARN
  AWS_ROLE_ARN?: string; // Role to assume for Bedrock access
  BEDROCK_DEFAULT_MODEL?: string; // Default model pattern after bedrock auth e.g. "claude-sonnet-4-6"
  SUBSCRIPTION_AUTH?: string; // Set to 'true' to allow startup without API keys (use /claude_auth or /openai_auth)
  MOLTBOT_EMAIL?: string; // Owner email for SSH key comment and git config
  // Cloudflare Access configuration for admin routes
  CF_ACCESS_TEAM_DOMAIN?: string; // e.g., 'myteam.cloudflareaccess.com'
  CF_ACCESS_AUD?: string; // Application Audience (AUD) tag
  // R2 credentials for bucket mounting (set via wrangler secret)
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string; // Override bucket name (default: 'moltbot-data')
  CF_ACCOUNT_ID?: string; // Cloudflare account ID for R2 endpoint
  // Browser Rendering binding for CDP shim
  BROWSER?: Fetcher;
  CDP_SECRET?: string; // Shared secret for CDP endpoint authentication
  WORKER_URL?: string; // Public URL of the worker (for CDP endpoint)
  // GitHub Apps credentials — JSON string, see GitHubAppsConfig for shape
  GITHUB_APPS?: string;
  // ACPX (Agent Control Protocol) configuration
  ACPX_ENABLED?: string;
  ACPX_ALLOWED_AGENTS?: string;
  // Node route for ACP/openclaw node connections (per-environment path, protected by CF Access Service Token)
  NODE_ROUTE?: string;
  NODE_ACCESS_AUD?: string; // CF Access Application AUD for node route — enables Worker-level JWT verification when set
  // Paired node for claude-node plugin (Claude Code dispatch)
  CLAUDE_NODE_NAME?: string;
  CLAUDE_NODE_WORKSPACE?: string; // Workspace path on the paired node
  CLAUDE_NODE_WORKSPACES?: string; // JSON string: workspace name→path mapping for multi-workspace ACP
}

/** Parsed shape of CLAUDE_NODE_WORKSPACES env var (workspace name → absolute path) */
export type ClaudeNodeWorkspaces = Record<string, string>;

/**
 * Shape of a single GitHub App credential entry in GITHUB_APPS JSON.
 * Companion documentation type — not imported at runtime. Decoding happens
 * in extensions/github-apps/scripts/decode_github_apps.js.
 */
export interface GitHubAppCredential {
  appId: string;
  installationId: string;
  /** base64-encoded RSA PEM private key */
  privateKey: string;
}

/**
 * Parsed shape of the GITHUB_APPS env var: { "<config-name>": GitHubAppCredential }.
 * Companion documentation type — see GitHubAppCredential for details.
 */
export type GitHubAppsConfig = Record<string, GitHubAppCredential>;

/**
 * Authenticated user from Cloudflare Access
 */
export interface AccessUser {
  email: string;
  name?: string;
}

/**
 * Hono app environment type
 */
export type AppEnv = {
  Bindings: MoltbotEnv;
  Variables: {
    sandbox: Sandbox;
    accessUser?: AccessUser;
  };
};

/**
 * JWT payload from Cloudflare Access
 */
export interface JWTPayload {
  aud: string[];
  email: string;
  exp: number;
  iat: number;
  iss: string;
  name?: string;
  sub: string;
  type: string;
}
