// Resolves configured nodeName → nodeId. Caches the mapping.

import { resolveAcpNodeIdByName, isAcpNodeConnected } from "openclaw/plugin-sdk/remote-acpx";

let cachedNodeId: string | null = null;
let cachedNodeName: string | null = null;

export function resolveNodeId(nodeName: string): string | null {
  if (cachedNodeName === nodeName && cachedNodeId && isAcpNodeConnected(cachedNodeId)) {
    return cachedNodeId;
  }
  const nodeId = resolveAcpNodeIdByName(nodeName);
  if (nodeId) {
    cachedNodeId = nodeId;
    cachedNodeName = nodeName;
  }
  return nodeId;
}

export function clearNodeCache(): void {
  cachedNodeId = null;
  cachedNodeName = null;
}
