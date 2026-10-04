import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig, projectConfig } from './config.mjs';
import { runCli } from './process.mjs';

const cli = fileURLToPath(new URL('./project.mjs', import.meta.url));
const names = ['gateway_project_prepare', 'gateway_project_github'];
const result = (details, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(details) }], details, ...(isError ? { isError: true } : {}) });

export function assignedProject(ctx, registry = loadConfig()) {
  if (ctx.sandboxed || ctx.messageChannel !== 'slack' || !ctx.sessionKey || !ctx.nativeChannelId) return null;
  const matches = Object.entries(registry).filter(([id, p]) =>
    ctx.agentId === `project-${id}` && ctx.workspaceDir === p.workspace &&
    (ctx.agentAccountId || 'default') === (p.slackAccountId || 'default') &&
    Array.isArray(p.slackChannelIds) && p.slackChannelIds.includes(ctx.nativeChannelId));
  return matches.length === 1 ? matches[0][0] : null;
}

export function createTools(ctx, { run = runCli, registry = loadConfig, project = projectConfig } = {}) {
  const id = assignedProject(ctx, registry());
  if (!id) return null;
  const execute = action => async (_callId, params, signal) => {
    try {
      // Recheck the mounted declaration on execution, including after removal.
      if (assignedProject(ctx, registry()) !== id) throw new Error('Project is no longer assigned to this conversation');
      const p = project(id);
      let argv;
      if (action === 'prepare') {
        if (typeof params.task !== 'string' || !params.task.trim() || params.task.length > 128) throw new Error('task must be a stable nonempty task identifier (max 128 characters)');
        argv = [cli, 'prepare', id, `${ctx.sessionKey}:${params.task}`];
      } else {
        if (!Array.isArray(params.args) || !params.args.length || params.args.length > 100 || params.args.some(a => typeof a !== 'string' || a.length > 16384 || a.includes('\0'))) throw new Error('args must contain 1–100 CLI argument strings');
        argv = [cli, 'gh', id, ...params.args];
      }
      const output = await run(argv, { signal, cwd: fs.existsSync(p.workspace) ? p.workspace : os.tmpdir() });
      if (output.exitCode !== 0) return result(output, true);
      return result(action === 'prepare' ? JSON.parse(output.stdout) : output);
    } catch (error) {
      return result({ error: error.message }, true);
    }
  };
  return [
    {
      name: names[0], label: 'Prepare Project Worktree',
      description: 'Prepare or resume a persistent worktree for this explicitly assigned project conversation. Reuse the task identifier on continuation. The project and session are supplied by the host.',
      parameters: { type: 'object', properties: { task: { type: 'string', minLength: 1, maxLength: 128, description: 'Stable task identifier within this conversation, e.g. issue-42. Use a new identifier for a separate task.' } }, required: ['task'], additionalProperties: false },
      execute: execute('prepare'),
    },
    {
      name: names[1], label: 'Project GitHub CLI',
      description: 'Run GitHub CLI for the assigned project using its existing identity. Supply arguments as an array, explicit PR head/base, and absolute body-file paths. Publish only within the user-authorized task; never request token output.',
      parameters: { type: 'object', properties: { args: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', maxLength: 16384 } } }, required: ['args'], additionalProperties: false },
      execute: execute('gh'),
    },
  ];
}

export default {
  id: 'gateway-projects',
  name: 'Gateway Projects',
  register(api) {
    api.registerTool(ctx => createTools(ctx), { names, optional: true });
    // No registerCommand or plugin-global skills: environment GitOps mounts the
    // non-user-invocable skill only in the assigned project's workspace.
  },
};
