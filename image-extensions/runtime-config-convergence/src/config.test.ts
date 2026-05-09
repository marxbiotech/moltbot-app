import { describe, expect, it } from "vitest";
import { parseConvergenceConfig } from "./config.js";

describe("parseConvergenceConfig", () => {
  it("provides safe defaults for empty input", () => {
    const c = parseConvergenceConfig({});
    expect(c.scanIntervalMs).toBe(0);
    expect(c.dryRun).toBe(false);
    expect(c.expectedSecretDriftNotify).toBe(false);
    expect(c.notification.transport).toBe("log-only");
    expect(c.httpRoute).toBeUndefined();
  });

  it("parses telegram notification with default env-var names", () => {
    const c = parseConvergenceConfig({ notification: { transport: "telegram" } });
    expect(c.notification.transport).toBe("telegram");
    if (c.notification.transport === "telegram") {
      expect(c.notification.botTokenEnv).toBe("TELEGRAM_BOT_TOKEN");
      expect(c.notification.chatIdEnv).toBe("TELEGRAM_LIFECYCLE_CHAT_ID");
    }
  });

  it("parses slack notification with custom env-var names", () => {
    const c = parseConvergenceConfig({
      notification: { transport: "slack", botTokenEnv: "SLACK_X", channelIdEnv: "SLACK_CH" },
    });
    if (c.notification.transport === "slack") {
      expect(c.notification.botTokenEnv).toBe("SLACK_X");
      expect(c.notification.channelIdEnv).toBe("SLACK_CH");
    }
  });

  it("normalizes unknown transport to log-only", () => {
    const c = parseConvergenceConfig({ notification: { transport: "openclaw" } });
    expect(c.notification.transport).toBe("log-only");
  });

  it("parses httpRoute with defaults and validates auth enum", () => {
    const c1 = parseConvergenceConfig({ httpRoute: {} });
    expect(c1.httpRoute?.path).toBe("/runtime-config-convergence/scan");
    expect(c1.httpRoute?.auth).toBe("plugin");
    const c2 = parseConvergenceConfig({ httpRoute: { auth: "gateway", path: "/x" } });
    expect(c2.httpRoute?.auth).toBe("gateway");
    expect(c2.httpRoute?.path).toBe("/x");
  });

  it("rejects negative scanIntervalMs (falls back to default)", () => {
    const c = parseConvergenceConfig({ scanIntervalMs: -5 });
    expect(c.scanIntervalMs).toBe(0);
  });
});
