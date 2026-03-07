import { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from './types';

/**
 * Custom Sandbox with Telegram lifecycle notifications.
 *
 * Sends notifications to the bot owner (TELEGRAM_LIFECYCLE_CHAT_ID) on
 * container start, stop, error, and sleep events.
 * Requires both TELEGRAM_BOT_TOKEN and TELEGRAM_LIFECYCLE_CHAT_ID to be set.
 */
export class MoltbotSandbox extends Sandbox<MoltbotEnv> {
  override onStart() {
    super.onStart();
    // Design Decision: notifyOwner is intentionally fire-and-forget here because
    // notifyOwner has its own internal try-catch, so no unhandled rejection is possible.
    // onStart is a sync override from Sandbox base class, so we cannot await here.
    this.notifyOwner('\u{1F7E2} Container 已啟動');
  }

  override async onStop() {
    await this.notifyOwner('\u{1F534} Container 已關閉');
    await super.onStop();
  }

  override onError(error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('new version rollout')) {
      this.notifyOwner('\u{1F504} Container 版本更新');
    } else {
      this.notifyOwner(`\u{26A0}\u{FE0F} Container 錯誤: ${msg}`);
    }
    super.onError(error);
  }

  override async onActivityExpired() {
    await this.notifyOwner('\u{1F4A4} Container 即將休眠');
    await super.onActivityExpired();
  }

  private async notifyOwner(text: string): Promise<void> {
    const botToken = this.env.TELEGRAM_BOT_TOKEN;
    const chatId = this.env.TELEGRAM_LIFECYCLE_CHAT_ID;
    if (!botToken || !chatId) return;

    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_notification: true }),
      });
      if (!res.ok) {
        console.error(`[LIFECYCLE] Telegram API error: ${res.status}`);
      }
    } catch (err) {
      console.error('[LIFECYCLE] Notification failed:', err);
    }
  }
}
