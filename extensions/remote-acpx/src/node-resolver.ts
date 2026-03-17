// Resolves configured nodeName → nodeId. Caches the mapping.
// Use Symbol.for globalThis to share cache across module loader instances.
// Same pattern as event-router.ts — jiti may load this module multiple times.

import { resolveAcpNodeIdByName, isAcpNodeConnected } from "openclaw/plugin-sdk/remote-acpx";

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
  const nodeId = resolveAcpNodeIdByName(nodeName);
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
