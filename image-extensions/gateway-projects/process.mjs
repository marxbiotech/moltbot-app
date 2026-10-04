import { spawn } from 'node:child_process';

// The CLI can wait on flock/Git. Never block the gateway's event loop, and cancel
// the entire CLI process group so a timed-out Git child cannot keep its lock.
export function runCli(argv, { signal, cwd, timeoutMs = 120_000, maxBytes = 1024 * 1024, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Project operation cancelled'));
    const child = spawn(process.execPath, argv, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, failure, killTimer;
    const kill = sig => { try { process.kill(-child.pid, sig); } catch (e) { if (e.code !== 'ESRCH') child.kill(sig); } };
    const stop = message => {
      if (failure) return;
      failure = new Error(message);
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1000);
    };
    const onAbort = () => stop('Project operation cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop('Project operation timed out'), timeoutMs);
    const collect = stream => data => {
      size += Buffer.byteLength(data);
      if (size > maxBytes) return stop('Project operation output exceeded limit');
      if (stream === 'stdout') stdout += data; else stderr += data;
    };
    child.stdout.setEncoding('utf8').on('data', collect('stdout'));
    child.stderr.setEncoding('utf8').on('data', collect('stderr'));
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', onAbort); };
    const redact = text => env.AGENT_GITHUB_PAT ? text.split(env.AGENT_GITHUB_PAT).join('[REDACTED]') : text;
    child.on('error', error => { cleanup(); reject(new Error(`Project CLI could not start (${error.code || 'unknown'})`)); });
    child.on('close', (code, exitSignal) => {
      if (failure) kill('SIGKILL');
      cleanup();
      if (failure) return reject(failure);
      resolve({ exitCode: code ?? 1, signal: exitSignal, stdout: redact(stdout), stderr: redact(stderr) });
    });
  });
}
