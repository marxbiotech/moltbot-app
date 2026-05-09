// Persona detection (Tailscale → HOSTNAME fallback).
//
// Intentionally duplicated from image-extensions/manage-secrets/src/shared.ts
// (where the same logic exists as `getPersona()`, currently un-exported).
//
// Cross-extension imports between sibling /opt/moltbot/extensions/* directories
// are not a clean pattern in this repo today (each extension has its own
// node_modules). When/if a shared utilities package is added under
// image-extensions/, both implementations should converge there. Until then,
// keep the two in sync.

import { execFileSync } from "node:child_process";

export function detectPersona(): string {
  // Try Tailscale hostname first (strip "moltbot-" prefix).
  try {
    const raw = execFileSync("tailscale", ["status", "--self", "--json"], {
      timeout: 5000,
      env: process.env,
    });
    const hostname = JSON.parse(raw.toString()).Self?.HostName || "";
    if (hostname.startsWith("moltbot-")) {
      return hostname.slice("moltbot-".length);
    }
  } catch (e: unknown) {
    // ENOENT = tailscale not installed, expected in non-Tailscale environments.
    const isNotFound = e instanceof Error
      && "code" in e
      && (e as NodeJS.ErrnoException).code === "ENOENT";
    if (!isNotFound) {
      console.warn(
        `[runtime-config-convergence] Tailscale persona detection failed, falling back to HOSTNAME: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // Fallback: HOSTNAME env var (K8s pod name pattern: moltbot-<persona>-<hash>-<hash>).
  const hostname = process.env.HOSTNAME || "";
  const match = hostname.match(/^moltbot-([a-z][\w-]*?)(?:-[a-f0-9]+-[a-z0-9]+)?$/);
  if (match) return match[1];

  return "";
}
