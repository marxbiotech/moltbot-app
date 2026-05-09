// Step 1 baseline: this plugin is a structural fork of `manage-secrets`,
// staged here so the upcoming detector / convergence work can be ported onto
// a single foundation. It is intentionally INERT in this step:
//
//   - register() is a no-op, so no tools are registered at runtime.
//   - openclaw.plugin.json declares "skills": [], so the copied SKILL.md
//     files (under ./skills/) are not loaded — this avoids name collisions
//     with the still-active `manage-secrets` plugin.
//   - The copied source under ./src/ (set-secret, set-config, preflight,
//     merge-patch, shared) is preserved verbatim apart from log-prefix
//     rebranding, ready to be wired up in a later step.
//
// The original `manage-secrets` plugin is unchanged and remains the live
// owner of the set_secret / set_config tool surface until env-side switches
// over to this plugin.
export default function register(_api: unknown): void {
  // Intentionally empty. See file header.
}
