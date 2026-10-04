import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
test('credentials are scoped; concurrent tasks and dirty continuations are preserved', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-project-test-'));
  try {
    const home = path.join(root, 'home'); fs.mkdirSync(home);
    const workspace = path.join(root, 'workspace');
    const configPath = path.join(root, 'projects.json');
    fs.writeFileSync(configPath, JSON.stringify({ capsule: { repository: 'example/capsule', workspace, authorName: 'Test', authorEmail: 'test@example.invalid' } }));
    const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GATEWAY_PROJECT_CONFIG: configPath, AGENT_GITHUB_PAT: 'test-only-sentinel' };
    delete env.GATEWAY_PROJECT_LOCKED;
    const exec = (cmd, args, options = {}) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', env, ...options });
      assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
    };
    const credential = input => exec(process.execPath, [path.join(here, 'credential.mjs'), 'get'], { input });
    assert.match(credential('protocol=https\nhost=github.com\npath=example/capsule.git\n\n'), /test-only-sentinel/);
    for (const input of [
      'protocol=https\nhost=github.com.evil.test\npath=example/capsule.git\n',
      'protocol=http\nhost=github.com\npath=example/capsule.git\n',
      'protocol=https\nhost=github.com\npath=other/repo.git\n',
      'protocol=https\nhost=github.com\n',
    ]) assert.equal(credential(input), '');
    assert.equal(exec(process.execPath, [path.join(here, 'credential.mjs'), 'store'], { input: 'password=do-not-store\n' }), '');

    const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env node\nif(process.env.GH_TOKEN!=="test-only-sentinel"||process.env.GH_REPO!=="example/capsule"||process.env.GH_HOST!=="github.com")process.exit(2); console.log(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
    assert.deepEqual(JSON.parse(exec(process.execPath, [path.join(here, 'project.mjs'), 'gh', 'capsule', 'issue', 'view', '42'], { env: { ...env, PATH: `${bin}:${env.PATH}` } })), ['issue', 'view', '42']);

    const remote = path.join(root, 'remote.git');
    exec('git', ['init', '--bare', '--initial-branch=main', remote]);
    const seed = path.join(root, 'seed');
    exec('git', ['clone', remote, seed]);
    exec('git', ['-C', seed, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial']);
    exec('git', ['-C', seed, 'push', 'origin', 'main']);
    exec('git', ['config', '--global', `url.${remote}.insteadOf`, 'https://github.com/example/capsule.git']);
    const prepare = task => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(here, 'project.mjs'), 'prepare', 'capsule', task], { env });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
      child.on('error', reject);
      child.on('exit', code => {
        try { assert.equal(code, 0, stderr); assert(!stdout.includes(env.AGENT_GITHUB_PAT)); resolve(JSON.parse(stdout)); }
        catch (e) { reject(e); }
      });
    });
    const [a, b] = await Promise.all([prepare('C1:123.456'), prepare('C2:123.456')]);
    assert.notEqual(a.worktree, b.worktree);
    fs.writeFileSync(path.join(a.worktree, 'unfinished.txt'), 'keep me');
    const stateFile = path.join(workspace, 'project-state', path.basename(a.worktree) + '.json');
    fs.writeFileSync(stateFile, JSON.stringify({ ...a, pr: 'https://github.com/example/capsule/pull/1' }));
    // No network needed to resume. Move the local test remote out of reach.
    fs.renameSync(remote, remote + '.offline');
    assert.deepEqual(await prepare('C1:123.456'), a);
    assert.equal(fs.readFileSync(path.join(a.worktree, 'unfinished.txt'), 'utf8'), 'keep me');
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pr, 'https://github.com/example/capsule/pull/1');
    assert.equal(exec('git', ['-C', a.worktree, 'config', 'user.email']), 'test@example.invalid');
    assert(!fs.readFileSync(path.join(workspace, 'repos/capsule/.git/config'), 'utf8').includes(env.AGENT_GITHUB_PAT));
    const invalid = spawnSync(process.execPath, [path.join(here, 'project.mjs'), 'prepare', '../capsule', 'x'], { env, encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
