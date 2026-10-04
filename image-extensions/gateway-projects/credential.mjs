#!/usr/bin/env node
import fs from 'node:fs';
import { loadConfig } from './config.mjs';

// Git's credential protocol only: never invoke this helper to display credentials.
// No storage; the token remains in the existing Kubernetes-provided environment.
if (process.argv[2] === 'get') {
  try {
    const fields = Object.fromEntries(fs.readFileSync(0, 'utf8').split('\n').filter(Boolean).map(line => {
      const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
    }));
    const repo = (fields.path || '').replace(/\.git$/, '').toLowerCase();
    const allowed = Object.values(loadConfig()).some(p => p.repository.toLowerCase() === repo);
    if (fields.protocol === 'https' && fields.host === 'github.com' && allowed && process.env.AGENT_GITHUB_PAT) {
      process.stdout.write(`username=x-access-token\npassword=${process.env.AGENT_GITHUB_PAT}\n\n`);
    }
  } catch {
    process.exitCode = 1;
  }
}
