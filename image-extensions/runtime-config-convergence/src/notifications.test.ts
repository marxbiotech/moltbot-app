import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAdapter, formatCandidateNotification } from "./notifications.js";
import type { DriftCandidate } from "./types.js";

function fakeCandidate(): DriftCandidate {
  return {
    id: "abc12345-auth-x",
    canonicalPath: "auth.x",
    liveValueHash: "abc12345" + "0".repeat(56),
    reasonCode: "repo-owned-drift",
    status: "active",
    firstSeenAt: "2026-05-01T00:00:00Z",
    lastSeenAt: "2026-05-01T00:00:00Z",
    seenCount: 1,
    notification: {},
    summary: { valueKind: "string", redacted: false },
  };
}

describe("formatCandidateNotification", () => {
  it("contains exactly one fixed reason line and the candidate id/path", () => {
    const text = formatCandidateNotification(fakeCandidate());
    const reasonLines = text.split("\n").filter((l) => l.startsWith("Reason:"));
    expect(reasonLines).toHaveLength(1);
    expect(reasonLines[0]).toBe("Reason: repo-owned-drift");
    expect(text).toContain("auth.x");
    expect(text).toContain("abc12345-auth-x");
  });

  it("never includes raw value content (only id/path/reason)", () => {
    const text = formatCandidateNotification(fakeCandidate());
    expect(text).not.toContain("liveValueHash"); // hash is internal
    expect(text).not.toContain("summary");
  });
});

describe("buildAdapter", () => {
  describe("none", () => {
    it("send is a no-op that returns ok+noSend", async () => {
      const a = buildAdapter({ transport: "none" });
      expect(a.ready().ok).toBe(true);
      const r = await a.send("hello");
      expect(r).toEqual({ ok: true, noSend: true });
    });
  });

  describe("log-only", () => {
    it("send writes to logger.info and returns ok+noSend", async () => {
      const a = buildAdapter({ transport: "log-only" });
      const r = await a.send("hello");
      expect(r.ok).toBe(true);
      expect(r.noSend).toBe(true);
    });
  });

  describe("telegram", () => {
    const TOKEN = "TEL_TEST_TOKEN";
    const CHAT = "TEL_TEST_CHAT";

    beforeEach(() => {
      process.env.TEL_TEST_TOKEN = "xxxx:yyy";
      process.env.TEL_TEST_CHAT = "12345";
    });
    afterEach(() => {
      delete process.env.TEL_TEST_TOKEN;
      delete process.env.TEL_TEST_CHAT;
    });

    it("ready=false when env vars missing", () => {
      delete process.env.TEL_TEST_TOKEN;
      const a = buildAdapter({ transport: "telegram", botTokenEnv: TOKEN, chatIdEnv: CHAT });
      const r = a.ready();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(TOKEN);
    });

    it("send POSTs to Telegram with chat_id and text", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "{}",
      } as unknown as Response);
      const a = buildAdapter(
        { transport: "telegram", botTokenEnv: TOKEN, chatIdEnv: CHAT },
        { fetchImpl: fetchMock as unknown as typeof fetch },
      );
      const r = await a.send("test message");
      expect(r.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain("api.telegram.org/botxxxx:yyy/sendMessage");
      const init = fetchMock.mock.calls[0][1] as { body: string };
      expect(JSON.parse(init.body)).toMatchObject({ chat_id: "12345", text: "test message" });
    });

    it("send returns ok=false on HTTP error without throwing", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => "bad request",
      } as unknown as Response);
      const a = buildAdapter(
        { transport: "telegram", botTokenEnv: TOKEN, chatIdEnv: CHAT },
        { fetchImpl: fetchMock as unknown as typeof fetch },
      );
      const r = await a.send("x");
      expect(r.ok).toBe(false);
      expect(r.error).toContain("400");
    });
  });

  describe("slack", () => {
    const TOKEN = "SLK_TEST_TOKEN";
    const CHAN = "SLK_TEST_CHAN";

    beforeEach(() => {
      process.env.SLK_TEST_TOKEN = "xoxb-...";
      process.env.SLK_TEST_CHAN = "C12345";
    });
    afterEach(() => {
      delete process.env.SLK_TEST_TOKEN;
      delete process.env.SLK_TEST_CHAN;
    });

    it("send POSTs to chat.postMessage with bearer auth", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      } as unknown as Response);
      const a = buildAdapter(
        { transport: "slack", botTokenEnv: TOKEN, channelIdEnv: CHAN },
        { fetchImpl: fetchMock as unknown as typeof fetch },
      );
      const r = await a.send("hi");
      expect(r.ok).toBe(true);
      const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string>; body: string };
      expect(init.headers.Authorization).toBe("Bearer xoxb-...");
      expect(JSON.parse(init.body)).toMatchObject({ channel: "C12345", text: "hi" });
    });

    it("send returns ok=false when Slack API responds ok=false", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, error: "channel_not_found" }),
      } as unknown as Response);
      const a = buildAdapter(
        { transport: "slack", botTokenEnv: TOKEN, channelIdEnv: CHAN },
        { fetchImpl: fetchMock as unknown as typeof fetch },
      );
      const r = await a.send("hi");
      expect(r.ok).toBe(false);
      expect(r.error).toContain("channel_not_found");
    });
  });
});
