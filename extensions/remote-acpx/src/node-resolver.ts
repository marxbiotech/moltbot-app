// Resolves nodeName → nodeId with caching. When nodeName is empty, auto-resolves to the first connected node.
// In auto-resolve mode, the first connected node is cached and reused until it disconnects,
// at which point the next connected node is selected.
// Use Symbol.for globalThis to share cache across module loader instances.
// Same pattern as event-router.ts — jiti may load this module multiple times.

import { resolveAcpNodeIdByName, isAcpNodeConnected, listAcpNodes } from "openclaw/plugin-sdk/remote-acpx";
import { log } from "./log.js";

interface NodeResolverCache {
  nodeId: string | null;
  nodeName: string | null;
}

const CACHE_KEY = Symbol.for("remote-acpx.node-resolver-cache");
const globalRef = globalThis as unknown as Record<symbol, NodeResolverCache>;
if (!globalRef[CACHE_KEY]) {
  globalRef[CACHE_KEY] = { nodeId: null, nodeName: null };
}
const cache = globalRef[CACHE_KEY];

export function resolveNodeId(nodeName: string): string | null {
  if (cache.nodeName === nodeName && cache.nodeId && isAcpNodeConnected(cache.nodeId)) {
    return cache.nodeId;
  }

  let nodeId: string | null;
  if (nodeName) {
    // Explicit name: resolve by display name
    nodeId = resolveAcpNodeIdByName(nodeName);
  } else {
    // Auto-resolve: use first connected node
    const nodes = listAcpNodes();
    const connected = nodes.find(n => isAcpNodeConnected(n.nodeId));
    nodeId = connected ? connected.nodeId : null;
    if (!nodeId) {
      log.info(`resolveNodeId: auto-resolve failed — ${nodes.length} node(s) registered, none connected`);
    }
  }

  if (nodeId) {
    cache.nodeId = nodeId;
    cache.nodeName = nodeName;
  }
  return nodeId;
}

export function clearNodeCache(): void {
  cache.nodeId = null;
  cache.nodeName = null;
}
