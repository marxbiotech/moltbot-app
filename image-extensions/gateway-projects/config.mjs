import fs from 'node:fs';
import path from 'node:path';

export function loadConfig() {
  return JSON.parse(fs.readFileSync(process.env.GATEWAY_PROJECT_CONFIG || '/etc/moltbot/gateway-projects/projects.json', 'utf8'));
}

export function projectConfig(id) {
  const config = loadConfig();
  const p = config[id];
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id) || !p) throw new Error('Unknown project');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.repository)) throw new Error('Invalid repository');
  if (!path.isAbsolute(p.workspace) || !p.authorName || !p.authorEmail) throw new Error('Invalid project configuration');
  return p;
}
