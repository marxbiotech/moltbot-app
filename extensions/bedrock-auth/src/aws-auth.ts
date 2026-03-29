import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

interface CheckResult {
  text: string;
}

function execFilePromise(
  cmd: string,
  args: string[],
  env?: Record<string, string | undefined>,
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

export async function awsAuth(mfaCode?: string): Promise<CheckResult> {
  const lines: string[] = [];

  if (!mfaCode) {
    return {
      text: [
        "Usage: /aws_auth <6-digit-mfa-code>",
        "",
        "Authenticates AWS Bedrock using STS assume-role with MFA.",
        "Requires: AWS_ROLE_ARN, AWS_MFA_SERIAL, AWS_BASE_ACCESS_KEY_ID, AWS_BASE_SECRET_ACCESS_KEY",
        "Optional: AWS_REGION (default: us-east-1)",
      ].join("\n"),
    };
  }

  if (!/^\d{6}$/.test(mfaCode)) {
    return { text: `[FAIL] Invalid MFA code: '${mfaCode}' (must be exactly 6 digits)` };
  }

  const roleArn = process.env.AWS_ROLE_ARN;
  const mfaSerial = process.env.AWS_MFA_SERIAL;
  const region = process.env.AWS_REGION ?? "us-east-1";

  if (!roleArn) return { text: "[FAIL] AWS_ROLE_ARN not set" };
  if (!mfaSerial) return { text: "[FAIL] AWS_MFA_SERIAL not set" };

  lines.push(`[INFO] Assuming role: ${roleArn}`);
  lines.push(`[INFO] MFA device: ${mfaSerial}`);
  lines.push(`[INFO] Region: ${region}`);
  lines.push("");

  // 1. Assume role with MFA
  let stsOutput: string;
  try {
    const { stdout } = await execFilePromise(
      "aws",
      [
        "sts", "assume-role",
        "--role-arn", roleArn,
        "--serial-number", mfaSerial,
        "--token-code", mfaCode,
        "--role-session-name", "OpenClawSession",
        "--duration-seconds", "43200",
        "--output", "json",
      ],
      {
        AWS_ACCESS_KEY_ID: process.env.AWS_BASE_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: process.env.AWS_BASE_SECRET_ACCESS_KEY,
      },
    );
    stsOutput = stdout;
  } catch (err: any) {
    const detail = (err.stdout ?? "") + (err.stderr ?? "");
    return { text: `[FAIL] STS assume-role failed:\n${detail || err.message}` };
  }

  // Parse credentials
  let creds: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string; Expiration: string };
  try {
    creds = JSON.parse(stsOutput).Credentials;
    if (!creds.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) throw new Error("missing fields");
  } catch {
    return { text: `[FAIL] Failed to parse STS credentials\n${stsOutput}` };
  }

  lines.push(`[PASS] STS credentials obtained (expires: ${creds.Expiration})`);

  // 2. Write session credentials
  const awsDir = path.join(os.homedir(), ".aws");
  fs.mkdirSync(awsDir, { recursive: true });
  fs.writeFileSync(
    path.join(awsDir, "session.json"),
    JSON.stringify({
      Version: 1,
      AccessKeyId: creds.AccessKeyId,
      SecretAccessKey: creds.SecretAccessKey,
      SessionToken: creds.SessionToken,
      Expiration: creds.Expiration,
    }),
  );
  lines.push("[PASS] Session credentials written (SDK will auto-refresh)");

  // 3. Switch default model to bedrock if configured
  const bedrockModel = process.env.BEDROCK_DEFAULT_MODEL;
  if (bedrockModel) {
    const home = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
    const configPath = path.join(home, "openclaw.json");
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const models: Record<string, unknown> = config.agents?.defaults?.models ?? {};
      const match = Object.keys(models).find(
        (id) => id.startsWith("amazon-bedrock/") && id.includes(bedrockModel),
      );
      if (match) {
        config.agents ??= {};
        config.agents.defaults ??= {};
        config.agents.defaults.model ??= {};
        config.agents.defaults.model.primary = match;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        lines.push(`[PASS] Default model switched to: ${match}`);
      } else {
        const available = Object.keys(models)
          .filter((id) => id.startsWith("amazon-bedrock/"))
          .join(", ");
        lines.push(`[WARN] No bedrock model matching pattern: ${bedrockModel}`);
        lines.push(`[WARN] Available models: ${available}`);
      }
    } catch (e: any) {
      lines.push(`[WARN] Could not set default model: ${e.message}`);
    }
  }

  lines.push("");
  lines.push("[PASS] AWS Bedrock authenticated! Session active for 12 hours.");
  lines.push(`Session expires: ${creds.Expiration}`);

  return { text: lines.join("\n") };
}
