import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, createHash } from "node:crypto";

/**
 * subscription-auth plugin — /claude_auth, /openai_auth, /openai_callback
 *
 * Authenticate with Claude Pro/Max subscription (setup-token) or
 * ChatGPT Plus/Pro subscription (OpenAI Codex OAuth PKCE).
 *
 * Uses registerCommand() so commands execute WITHOUT the AI agent.
 * Credentials are written to auth-profiles.json which is auto-synced to R2.
 */

const AUTH_FILE = "/root/.openclaw/agents/main/agent/auth-profiles.json";
const CONFIG_FILE = "/root/.openclaw/openclaw.json";

// OpenAI Codex OAuth constants (from openai/codex source: codex-rs/core/src/auth.rs)
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_ISSUER = "https://auth.openai.com";
const OPENAI_REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const OPENAI_SCOPE = "openid profile email offline_access";

const PKCE_STATE_FILE = "/tmp/.codex-pkce-state";

// ── Helpers ──────────────────────────────────────────────────

type AuthProfileStore = {
  version: number;
  profiles: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

function readAuthStore(): AuthProfileStore {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf8"));
  } catch {
    return { version: 1, profiles: {} };
  }
}

function writeAuthStore(store: AuthProfileStore): void {
  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(store, null, 2));
}

function readConfig(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(config: Record<string, any>): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function addModelsToAllowlist(
  config: Record<string, any>,
  models: Record<string, { alias: string }>,
): void {
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.models ??= {};
  Object.assign(config.agents.defaults.models, models);
}

// ── /claude_auth ─────────────────────────────────────────────

function handleClaudeAuth(token: string): string {
  const lines: string[] = [];

  // Validate format
  if (!token) {
    return [
      "Usage: /claude_auth <setup-token>",
      "",
      "Paste a Claude setup-token to authenticate with your Claude Pro/Max subscription.",
      "Generate the token on any machine: claude setup-token",
    ].join("\n");
  }

  if (!/^sk-ant-oat01-.{70,}/.test(token)) {
    return [
      "[FAIL] Invalid setup-token format",
      "Expected: starts with 'sk-ant-oat01-', at least 80 characters",
    ].join("\n");
  }

  // Write to auth-profiles.json
  const store = readAuthStore();
  store.profiles["anthropic:manual"] = {
    type: "token",
    provider: "anthropic",
    token: token,
  };
  writeAuthStore(store);
  lines.push("[PASS] Setup-token written to auth-profiles.json");

  // Update openclaw.json — add anthropic models to allowlist
  try {
    const config = readConfig();
    addModelsToAllowlist(config, {
      "anthropic/claude-sonnet-4-6": { alias: "Claude Sonnet 4.6" },
      "anthropic/claude-opus-4-6": { alias: "Claude Opus 4.6" },
      "anthropic/claude-haiku-4-5": { alias: "Claude Haiku 4.5" },
    });

    // Set default model to anthropic if not already set to anthropic
    const currentDefault = config.agents?.defaults?.model?.primary;
    if (!currentDefault || !currentDefault.startsWith("anthropic/")) {
      config.agents.defaults.model ??= {};
      config.agents.defaults.model.primary = "anthropic/claude-sonnet-4-6";
      lines.push("[PASS] Default model set to: anthropic/claude-sonnet-4-6");
    }

    writeConfig(config);
    lines.push("[PASS] Anthropic models added to allowlist");
  } catch (e: any) {
    lines.push("[WARN] Could not update config: " + e.message);
  }

  lines.push("");
  lines.push("[PASS] Claude subscription authenticated!");
  lines.push("Use /model to switch between models.");
  return lines.join("\n");
}

// ── /openai_auth ─────────────────────────────────────────────

function handleOpenaiAuth(): string {
  // Generate PKCE verifier + challenge
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");

  // Build authorize URL (matches codex-rs/login/src/server.rs)
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_CLIENT_ID,
    redirect_uri: OPENAI_REDIRECT_URI,
    scope: OPENAI_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: state,
  });
  const url = `${OPENAI_ISSUER}/oauth/authorize?${params.toString()}`;

  // Save state for callback
  writeFileSync(
    PKCE_STATE_FILE,
    JSON.stringify({ verifier, state, clientId: OPENAI_CLIENT_ID, redirectUri: OPENAI_REDIRECT_URI }),
  );

  return [
    "[INFO] Open this URL in your browser to sign in with ChatGPT:",
    "",
    url,
    "",
    "[INFO] After signing in, you will be redirected to a page that won't load.",
    "[INFO] Copy the FULL URL from your browser's address bar and run:",
    "[INFO]   /openai_callback <paste-url-here>",
  ].join("\n");
}

// ── /openai_callback ─────────────────────────────────────────

async function handleOpenaiCallback(redirectUrl: string): Promise<string> {
  const lines: string[] = [];

  if (!redirectUrl) {
    return [
      "Usage: /openai_callback <redirect-url>",
      "Paste the full redirect URL from your browser after signing in.",
    ].join("\n");
  }

  // Read saved PKCE state
  let saved: { verifier: string; state: string; clientId: string; redirectUri: string };
  try {
    saved = JSON.parse(readFileSync(PKCE_STATE_FILE, "utf8"));
  } catch {
    return "[FAIL] No pending OAuth flow. Run /openai_auth first.";
  }

  // Extract code and state from redirect URL
  let parsed: URL;
  try {
    parsed = new URL(redirectUrl);
  } catch {
    return "[FAIL] Invalid URL. Paste the complete URL from your browser's address bar.";
  }

  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state");

  if (!code) {
    return "[FAIL] No authorization code found in URL";
  }
  if (state !== saved.state) {
    return "[FAIL] State mismatch — possible CSRF. Run /openai_auth again.";
  }

  // Exchange code for tokens
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: code,
    redirect_uri: saved.redirectUri,
    client_id: saved.clientId,
    code_verifier: saved.verifier,
  });

  let data: any;
  try {
    const resp = await fetch(`${OPENAI_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return `[FAIL] Token exchange failed: ${resp.status} ${text}`;
    }

    data = await resp.json();
  } catch (e: any) {
    return `[FAIL] Token exchange request failed: ${e.message}`;
  }

  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000 - 5 * 60 * 1000;

  // Write to auth-profiles.json
  const store = readAuthStore();
  store.profiles["openai-codex:default"] = {
    type: "oauth",
    provider: "openai-codex",
    access: data.access_token,
    refresh: data.refresh_token,
    expires: expiresAt,
  };
  writeAuthStore(store);
  lines.push("[PASS] OAuth credentials written to auth-profiles.json");

  // Update openclaw.json — add openai-codex models
  try {
    const config = readConfig();
    addModelsToAllowlist(config, {
      "openai-codex/gpt-5.3-codex": { alias: "GPT-5.3 Codex" },
      "openai-codex/gpt-5.1-codex-max": { alias: "GPT-5.1 Codex Max" },
      "openai-codex/gpt-5-codex-mini": { alias: "GPT-5 Codex Mini" },
    });
    writeConfig(config);
    lines.push("[PASS] OpenAI Codex models added to allowlist");
  } catch (e: any) {
    lines.push("[WARN] Could not update config: " + e.message);
  }

  // Cleanup PKCE state
  try {
    unlinkSync(PKCE_STATE_FILE);
  } catch {}

  lines.push("");
  lines.push("[PASS] OpenAI Codex subscription authenticated!");
  lines.push("OAuth token will auto-refresh. Use /model to switch models.");
  return lines.join("\n");
}

// ── Plugin registration ──────────────────────────────────────

export default function register(api: any) {
  api.registerCommand({
    name: "claude_auth",
    description: "Authenticate with Claude Pro/Max subscription (setup-token)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const args = ctx.args?.trim() ?? "";
      return { text: handleClaudeAuth(args) };
    },
  });

  api.registerCommand({
    name: "openai_auth",
    description: "Start OpenAI Codex OAuth sign-in (ChatGPT Plus/Pro subscription)",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      return { text: handleOpenaiAuth() };
    },
  });

  api.registerCommand({
    name: "openai_callback",
    description: "Complete OpenAI Codex OAuth sign-in (paste redirect URL)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const args = ctx.args?.trim() ?? "";
      return { text: await handleOpenaiCallback(args) };
    },
  });
}
