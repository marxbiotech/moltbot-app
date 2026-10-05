import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function registryFromConfig(config) {
  const entry = config?.plugins?.entries?.['gateway-projects'];
  return entry?.enabled === true ? (entry.config?.projects ?? {}) : {};
}

export function loadConfig(env = process.env) {
  // Plugin calls carry their selected project snapshot through the child environment.
  if (env.GATEWAY_PROJECT_REGISTRY_JSON !== undefined) return JSON.parse(env.GATEWAY_PROJECT_REGISTRY_JSON);
  // Standalone Git/CLI calls use the same native OpenClaw JSON configuration.
  const configPath = env.OPENCLAW_CONFIG_PATH || path.join(env.OPENCLAW_STATE_DIR || path.join(env.HOME || os.homedir(), '.openclaw'), 'openclaw.json');
  return registryFromConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
}

export function projectConfig(id, config = loadConfig()) {
  const p = config[id];
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id) || !p) throw new Error('Unknown project');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.repository)) throw new Error('Invalid repository');
  if (!path.isAbsolute(p.workspace) || !p.authorName || !p.authorEmail) throw new Error('Invalid project configuration');
  return p;
}
