# Remote ACPX for v2026.9.5

This plugin lets a Gateway agent run ACP coding sessions through `acpx@0.16.0`
on one explicitly selected paired node. The Gateway uses OpenClaw's ACP session,
task, cancellation, and reply delivery owners. Workspaces, harness processes,
credentials, and acpx records remain on the node.

Use the v2026.9.5 fork containing `openclaw/plugin-sdk/acp-backend` on both hosts.
Autonomous execution also requires the node host's
`prepareConfiguredExecAuthorization()` capability, included in image beta.2.
The unmodified upstream package has the node transport but keeps ACP backend
registration behind a private SDK facade. This plugin requires the fork's small
public contract addition; it does not contain a private SDK fallback.

The previous remote bridge, `run_coder`, roster tools, in-memory job store, and
legacy configuration are removed. Use the old release for those behaviors.
There is no session/job migration from that implementation.

## Configure both hosts

Install this same plugin directory and its production dependencies on the
Gateway and node. Include its absolute directory in `plugins.load.paths`, enable
`plugins.entries.remote-acpx`, and include `remote-acpx` in the plugin allowlist.
For a source installation, run `npm ci --omit=dev --ignore-scripts` in this
plugin directory. Do not copy development `node_modules` into an image.

Gateway configuration (merge these fields into your configuration):

```json
{
  "agents": {
    "ownership": "explicit",
    "defaults": { "systemAgent": { "agentId": "main" } },
    "entries": {
      "main": {},
      "claude": {
        "runtime": {
          "type": "acp",
          "acp": { "agent": "claude", "backend": "remote-acpx" }
        }
      }
    }
  },
  "acp": {
    "enabled": true,
    "dispatch": { "enabled": true },
    "backend": "remote-acpx",
    "fallbacks": [],
    "defaultAgent": "claude",
    "allowedAgents": ["claude"]
  },
  "gateway": {
    "nodes": { "commands": { "allow": ["remote-acpx.execute"] } }
  },
  "plugins": {
    "allow": ["remote-acpx"],
    "load": { "paths": ["/opt/moltbot/extensions/remote-acpx"] },
    "entries": {
      "remote-acpx": {
        "enabled": true,
        "config": {
          "target": {
            "nodeId": "PAIRED_NODE_ID",
            "cwd": "/absolute/workspace/on/node"
          }
        }
      }
    }
  }
}
```

Use the stable paired node ID shown by `openclaw nodes status`, not its display
name or the `node run --node-id` instance label. Optional
`targets: { "OPENCLAW_AGENT_ID": { "nodeId": "...", "cwd": "..." } }` selects a
node per session owner; `target` is the default. Explicit ACP `cwd` overrides the
configured default and must be an absolute path on the node.
Merge the example agent entries into the existing roster; keep the deployment's
chosen system agent. The ACP executor must exist in `agents.entries` as well as
`acp.allowedAgents`; the allowlist alone does not register an agent. The
coordinator's tool policy must expose `read`, `sessions_spawn`, and the session
and task tools needed for follow-up.

Node plugin configuration:

```json
{
  "plugins": {
    "allow": ["remote-acpx"],
    "load": { "paths": ["/absolute/path/to/remote-acpx"] },
    "entries": {
      "remote-acpx": {
        "enabled": true,
        "config": {
          "node": {
            "cwd": "/absolute/workspace/on/node",
            "stateDir": "/absolute/node-state/remote-acpx",
            "agents": {
              "claude": ["/absolute/path/to/claude-agent-acp"]
            },
            "permissionMode": "approve-reads"
          }
        }
      }
    }
  }
}
```

The node supports macOS and Linux. Install and authenticate the chosen ACP
harness locally on the node. `agents` supplies local executable argv overrides;
acpx's known built-in agent IDs also work. Unknown agent IDs are rejected rather
than interpreted as executable commands. Gateway-supplied environment overrides
are rejected. Node-local acpx state uses the upstream acpx file-store contract.

Pair the node and explicitly approve its `remote-acpx.execute` command surface.
Node-local execution policy must permit the command. The default
`executionApproval: "always"` requests a real OpenClaw **Allow once** decision
for each operation except cancellation, including creation, turns, and status.

For an operator-authorized autonomous Gateway agent, set
`plugins.entries.remote-acpx.config.executionApproval: "node-policy"` on the
Gateway. The policy checks the current `target` / owner-specific `targets`
selection before dispatch. On the node, configure the applicable agent's exec
policy and canonical exec approvals document to permit `security: "full"` and
`ask: "off"`. Either a more restrictive node config or approvals floor prevents
autonomous execution. Use the node's normal `openclaw approvals` interface to
inspect and update that document, preserving unrelated agent policies.

This mode permits execution as the node account; `cwd` selects a workspace, not
a filesystem sandbox. Use agent-specific node policies where appropriate.
The node host must provide `prepareConfiguredExecAuthorization()`; an older host
fails closed instead of treating this as a human approval. Each operation,
including setup-worker reuse, obtains a new live guard immediately before
execution. Config reload, policy tightening, disconnect, and invocation closure
invalidate the relevant authority. No plugin approval cache or fabricated
Session Full grant is used.

`node.permissionMode` independently controls the harness's file/tool requests
(`approve-reads`, `approve-all`, or `deny-all`). For coding work that should edit
and run commands autonomously, the operator must also choose an appropriate
harness permission mode. It never overrides node execution policy. Cancellation
of an admitted worker needs no new approval.

## Use and lifecycle

The packaged `remote-acp-router` skill teaches the Gateway agent to call
`sessions_spawn` itself with `runtime: "acp"`, an allowed harness, a node-local
`cwd`, `mode: "run"`, and `streamTo: "parent"`. The user supplies the task in
ordinary language. The core owns background completion delivery; the Gateway
agent summarizes the result. Standard session tools carry follow-up instructions,
and `subagents` lists, waits for, or cancels owned tasks. The user does not need
to enter `/acp` commands, and ordinary delegation does not bind their conversation
directly to the harness. No extra model tool or parallel job manager is registered.

Channel skill filters may continue to name `remote-acp-router`, but replace old
prompts requiring `run_coder` or roster tools and remove any legacy skill copy
that shadows the packaged skill. Provide the selected harness and
absolute node-local project workspace in the channel's routing context. Project
aliases must be configured ACP agents; old roster ids are not automatically
available. A per-owner node target is keyed by the resulting ACP session owner,
not by the coordinating Gateway parent session.

`mode: "run"` is one-shot: completion closes the native harness session. Supply
the previous findings and decisions in full for subsequent work. `sessions_send`
can queue a follow-up but does not make a one-shot child retain harness memory;
its native-agent `steer` and `resume` modes do not apply to ACP. Persistent native
context requires a supported child thread with `mode: "session", thread: true`.

For persistent sessions, the handle retains node affinity and the node's exact acpx session
locator. A disconnected node never redirects work to the Gateway or another
node. A restarted Gateway can resume the same conversation from its persisted
handle and node-local record. Owners with the same bare session key are isolated.
Stale generation handles cannot control a replacement session.

Turns stream progress and elicitation over the upstream duplex transport.
Cancellation waits for the node's actual result and worker cleanup. Disconnect
or service shutdown cancels owned processes; work does not continue detached.
An interrupted prompt is never automatically replayed because it may already
have changed files. Inspect the session/workspace before resubmitting it.

Session setup retains its node-owned worker through initial controls and the next
turn: some ACP harnesses, including Claude, do not persist a new session until
its first prompt. Every invocation rechecks execution authority before either
launching or reusing a worker. Turns join acpx cleanup and worker exit before
returning their terminal result; close, reset, and node disconnect also release
setup workers. Later persistent turns resume the durable harness session in a new worker.
An empty session lost with its node connection may require an explicit reset;
no prompt is automatically replayed. A session has at most one writer, while
status reads can run during a turn. Messages are
limited to 8 MiB and pending event/delivery buffers to 16 MiB; overflow cancels
work with an error. Upstream node heartbeats keep silent long turns alive.

Explicit unsupported thinking/model selections fail. Inherited thinking is
reported as dropped; an inherited model is dropped only when the harness lacks
model-selection capability. Attachments are forwarded through acpx.

## Development

Build the sibling `openclaw` checkout at this feature's matching revision, then
install this package's development dependencies. Run `npm run typecheck` and
`npm test`. Tests use synthetic ACP agents and temporary state; no provider
credentials or running deployment are needed.

Run `node test/live-gateway.mjs` for the isolated loopback integration proof. It
starts its own Gateway and node, performs real pairing and approval, verifies a
35-second silent turn and the canonical ACP manager through `chat.send`, then
stops its processes and removes its temporary state. Real provider credentials
and networking between different machines remain deployment checks.
`node test/live-gateway.mjs --agent-spawn` additionally uses a deterministic
model peer to exercise skill discovery/read, the real agent tool call,
configured node authorization without a reviewer, and parent completion delivery.

## Images

The application Dockerfile pins
`ghcr.io/marxbiotech/openclaw:mb2026.9.5-beta.2`, which contains the public ACP
backend contract and configured node execution guard. The host package version remains `2026.9.5`; the `mb` prefix
and beta suffix identify the fork's image release.

Application image tags derive from that base version and the application commit:
`ghcr.io/marxbiotech/moltbot-app:mb2026.9.5-beta.2-<short-commit>`.
Feature-branch builds publish only that versioned tag. The image build runs
`test/image-smoke.mjs` as the non-root runtime user to check actual plugin
registration, agent skill discovery, and production worker imports on each target architecture.

Publishing an image does not update an existing Gateway or paired node. Both
hosts still require the matching fork runtime and this plugin configuration.
