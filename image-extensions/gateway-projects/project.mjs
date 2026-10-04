#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectConfig } from './config.mjs';

const [command, id, ...args] = process.argv.slice(2);
function run(exe, argv, options = {}) {
  const result = spawnSync(exe, argv, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`${exe} failed (exit ${result.status ?? 'unavailable'})`);
  return result.stdout?.trim();
}

try {
  const p = projectConfig(id);
  if (command === 'gh') {
    if (!process.env.AGENT_GITHUB_PAT) throw new Error('AGENT_GITHUB_PAT is not configured');
    const result = spawnSync('gh', args, {
      stdio: 'inherit',
      env: { ...process.env, GH_TOKEN: process.env.AGENT_GITHUB_PAT, GH_HOST: 'github.com', GH_REPO: p.repository, GH_PROMPT_DISABLED: '1' },
    });
    process.exit(result.status ?? 1);
  }
  if (command !== 'prepare' || args.length !== 1 || !args[0] || args[0].length > 1024) {
    throw new Error('Usage: gateway-project prepare PROJECT TASK_KEY | gateway-project gh PROJECT <gh arguments>');
  }
  // A caller supplies a stable Slack channel + thread root, or an explicit task id.
  // Hashing avoids path traversal and invalid Git branch characters.
  const key = createHash('sha256').update(args[0]).digest('hex').slice(0, 24);
  fs.mkdirSync(p.workspace, { recursive: true, mode: 0o700 });
  if (process.env.GATEWAY_PROJECT_LOCKED !== `${id}:${key}`) {
    const result = spawnSync('flock', ['-w', '60', path.join(p.workspace, '.git-operations.lock'), process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: 'inherit', env: { ...process.env, GATEWAY_PROJECT_LOCKED: `${id}:${key}` },
    });
    process.exit(result.status ?? 1);
  }
  const repo = path.join(p.workspace, 'repos', id);
  const worktree = path.join(p.workspace, 'worktrees', key);
  const branch = `merlin/${key}`;
  const url = `https://github.com/${p.repository}.git`;
  const git = (argv, cwd = repo) => run('git', argv, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  if (!fs.existsSync(repo)) {
    // Clone into a temporary sibling so an interrupted clone never looks complete.
    const staging = fs.mkdtempSync(`${repo}.clone-`);
    try {
      git(['-c', 'credential.helper=', '-c', 'credential.helper=gateway-project', '-c', 'credential.useHttpPath=true', 'clone', '--no-checkout', url, staging], p.workspace);
      fs.renameSync(staging, repo);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  if (git(['config', '--get', 'remote.origin.url']) !== url) throw new Error('Existing repository origin does not match declared project');
  git(['config', '--local', '--replace-all', 'credential.helper', '']);
  git(['config', '--local', '--add', 'credential.helper', 'gateway-project']);
  git(['config', '--local', 'credential.useHttpPath', 'true']);
  git(['config', '--local', 'user.name', p.authorName]);
  git(['config', '--local', 'user.email', p.authorEmail]);
  if (fs.existsSync(worktree)) {
    if (git(['rev-parse', '--show-toplevel'], worktree) !== worktree || git(['branch', '--show-current'], worktree) !== branch) {
      throw new Error('Existing task worktree does not match; inspect it before continuing');
    }
  } else {
    git(['fetch', 'origin']);
    const base = p.baseBranch || 'main';
    git(['check-ref-format', '--branch', base]);
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    const exists = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo }).status === 0;
    git(exists ? ['worktree', 'add', worktree, branch] : ['worktree', 'add', '-b', branch, worktree, `refs/remotes/origin/${base}`]);
  }
  const stateDir = path.join(p.workspace, 'project-state');
  fs.mkdirSync(stateDir, { recursive: true });
  const state = { task: args[0], project: id, repository: p.repository, branch, worktree };
  const statePath = path.join(stateDir, `${key}.json`);
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(`${statePath}.tmp`, statePath);
  }
  console.log(JSON.stringify(state));
} catch (error) {
  // Deliberately do not echo subprocess stderr: transport errors can contain credentials.
  console.error(error.message);
  process.exitCode = 1;
}
