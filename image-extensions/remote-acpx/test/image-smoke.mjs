import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const cli = process.argv[2] ?? "/app/openclaw.mjs";
const state = mkdtempSync(path.join(tmpdir(), "remote-acpx-image-smoke-"));
const env = {
  PATH: process.env.PATH,
  HOME: state,
  USERPROFILE: state,
  OPENCLAW_HOME: state,
  OPENCLAW_STATE_DIR: path.join(state, "state"),
  OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  OPENCLAW_NO_ONBOARD: "1",
  OPENCLAW_SUPPRESS_NOTES: "1",
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  AWS_EC2_METADATA_DISABLED: "true",
  NODE_ENV: "production",
};

try {
  writeFileSync(
    env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({
      plugins: {
        allow: ["remote-acpx"],
        load: { paths: [pluginRoot] },
        entries: { "remote-acpx": { enabled: true } },
      },
    }),
  );
  const output = execFileSync(
    process.execPath,
    [cli, "plugins", "inspect", "remote-acpx", "--runtime", "--json"],
    { env, cwd: state, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const report = JSON.parse(output);
  assert.equal(report.plugin.id, "remote-acpx");
  assert.equal(report.plugin.status, "loaded", JSON.stringify(report.diagnostics));
  assert.ok(report.services.includes("remote-acpx-runtime"), "ACP backend service registered");
  const skills = JSON.parse(
    execFileSync(process.execPath, [cli, "skills", "list", "--json"], {
      env,
      cwd: state,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
  const router = skills.skills.find((skill) => skill.name === "remote-acp-router");
  assert.ok(
    router?.eligible && router.modelVisible,
    "the remote routing skill is available to agents",
  );
  assert.equal(router.userInvocable, false, "routing does not require a user slash command");
  execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", "await import('./src/worker-runtime.ts')"],
    { env, cwd: pluginRoot, stdio: "inherit", timeout: 30_000 },
  );
  console.log(
    "Verified image plugin registration, agent skill discovery, and production ACP worker dependencies.",
  );
} finally {
  rmSync(state, { recursive: true, force: true });
}
