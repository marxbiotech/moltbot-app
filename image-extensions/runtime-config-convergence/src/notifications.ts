// Provider/deployment-specific notification adapter.
//
// Per issue #35 §8: OpenClaw plugins do not currently expose a generic
// proactive "send to arbitrary conversation" API, so notifications go through
// real provider-specific transports (Telegram Bot API / Slack Web API), or
// `log-only` / `none`.
//
// Adapter contract: `sendNotification(text)` resolves to a result describing
// whether the send was successful. Failures must NOT throw — the detector
// records the error on the candidate and continues.

import type { DriftCandidate, NotificationConfig } from "./types.js";

/**
 * Discriminated union: the success branch never carries an error, and the
 * failure branch always carries one. `noSend` means the adapter intentionally
 * skipped the wire (log-only / none) but the contract was satisfied.
 */
export type NotificationResult =
  | { ok: true; noSend?: boolean }
  | { ok: false; error: string };

export interface NotificationAdapter {
  /** Provider/transport label for logs and `notify-test` output. */
  describe(): string;
  /** Whether the adapter is fully configured (has tokens / target). */
  ready(): { ok: true } | { ok: false; reason: string };
  send(text: string): Promise<NotificationResult>;
}

interface AdapterDeps {
  fetchImpl?: typeof fetch;
}

/** Per-request HTTP timeout for provider sends. Bounded so an unresponsive API
 *  cannot stall the scan loop indefinitely (the service tick overlap guard
 *  would otherwise starve subsequent ticks). */
const SEND_TIMEOUT_MS = 10_000;

class NoneAdapter implements NotificationAdapter {
  describe(): string { return "none (notifications disabled)"; }
  ready(): { ok: true } { return { ok: true }; }
  async send(_text: string): Promise<NotificationResult> {
    return { ok: true, noSend: true };
  }
}

class LogOnlyAdapter implements NotificationAdapter {
  constructor(private readonly logger: { info: (msg: string) => void } = console) {}
  describe(): string { return "log-only (stdout/log)"; }
  ready(): { ok: true } { return { ok: true }; }
  async send(text: string): Promise<NotificationResult> {
    this.logger.info(`[runtime-config-convergence] ${text.replace(/\n/g, " | ")}`);
    return { ok: true, noSend: true };
  }
}

class TelegramAdapter implements NotificationAdapter {
  private readonly token: string;
  private readonly chatId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenEnv: string;
  private readonly chatIdEnv: string;
  constructor(cfg: { botTokenEnv: string; chatIdEnv: string }, deps: AdapterDeps = {}) {
    this.tokenEnv = cfg.botTokenEnv;
    this.chatIdEnv = cfg.chatIdEnv;
    this.token = process.env[cfg.botTokenEnv] ?? "";
    this.chatId = process.env[cfg.chatIdEnv] ?? "";
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }
  describe(): string {
    return `telegram (token=${this.tokenEnv}, chat=${this.chatIdEnv}${this.chatId ? `=${this.chatId}` : "(unset)"})`;
  }
  ready(): { ok: true } | { ok: false; reason: string } {
    if (!this.token) return { ok: false, reason: `${this.tokenEnv} is not set` };
    if (!this.chatId) return { ok: false, reason: `${this.chatIdEnv} is not set` };
    return { ok: true };
  }
  async send(text: string): Promise<NotificationResult> {
    const ready = this.ready();
    if (!ready.ok) return { ok: false, error: ready.reason };
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text, disable_notification: true }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "<no body>");
        return { ok: false, error: `Telegram sendMessage HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

class SlackAdapter implements NotificationAdapter {
  private readonly token: string;
  private readonly channelId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenEnv: string;
  private readonly channelIdEnv: string;
  constructor(cfg: { botTokenEnv: string; channelIdEnv: string }, deps: AdapterDeps = {}) {
    this.tokenEnv = cfg.botTokenEnv;
    this.channelIdEnv = cfg.channelIdEnv;
    this.token = process.env[cfg.botTokenEnv] ?? "";
    this.channelId = process.env[cfg.channelIdEnv] ?? "";
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }
  describe(): string {
    return `slack (token=${this.tokenEnv}, channel=${this.channelIdEnv}${this.channelId ? `=${this.channelId}` : "(unset)"})`;
  }
  ready(): { ok: true } | { ok: false; reason: string } {
    if (!this.token) return { ok: false, reason: `${this.tokenEnv} is not set` };
    if (!this.channelId) return { ok: false, reason: `${this.channelIdEnv} is not set` };
    return { ok: true };
  }
  async send(text: string): Promise<NotificationResult> {
    const ready = this.ready();
    if (!ready.ok) return { ok: false, error: ready.reason };
    try {
      const res = await this.fetchImpl("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ channel: this.channelId, text }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      // Mirror the Telegram pattern: text() on non-2xx (Slack may return CDN
      // HTML pages on 401/429/5xx that don't parse as JSON), json() on 2xx.
      if (!res.ok) {
        const body = await res.text().catch(() => "<no body>");
        return { ok: false, error: `Slack chat.postMessage HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      // Strict ok check: an unparseable / unexpected JSON body (CDN HTML on
      // 200, content-type misconfig) must be treated as failure, not silently
      // promoted to "ok" by the absence of `ok: false`.
      const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!json || json.ok !== true) {
        return { ok: false, error: `Slack chat.postMessage error: ${json?.error ?? "missing or invalid response body"}` };
      }
      return { ok: true };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

export function buildAdapter(cfg: NotificationConfig, deps: AdapterDeps = {}): NotificationAdapter {
  switch (cfg.transport) {
    case "telegram":
      return new TelegramAdapter({
        botTokenEnv: cfg.botTokenEnv ?? "TELEGRAM_BOT_TOKEN",
        chatIdEnv: cfg.chatIdEnv ?? "TELEGRAM_LIFECYCLE_CHAT_ID",
      }, deps);
    case "slack":
      return new SlackAdapter({
        botTokenEnv: cfg.botTokenEnv ?? "SLACK_BOT_TOKEN",
        channelIdEnv: cfg.channelIdEnv ?? "SLACK_LIFECYCLE_CHANNEL_ID",
      }, deps);
    case "none":
      return new NoneAdapter();
    case "log-only":
    default:
      return new LogOnlyAdapter();
  }
}

/** Build the v1 fixed-shape notification text for a new candidate. */
export function formatCandidateNotification(c: DriftCandidate): string {
  return [
    `Runtime config drift candidate: ${c.id}`,
    `Path: ${c.canonicalPath}`,
    `Reason: ${c.reasonCode}`,
    `Status: ${c.status}`,
    `Seen: first time`,
    "",
    `Use /config-drift show ${c.id} for details.`,
    `Use /config-drift ignore ${c.id} to ignore this exact live value.`,
  ].join("\n");
}
