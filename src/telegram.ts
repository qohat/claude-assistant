// Bot de Telegram por long-polling con fetch nativo (sin framework).
// Portado de code-assistant v1 (agent/telegram.py): offset, filtro de chat,
// chunking a 3800 chars y Markdown con fallback a texto plano.
import { CONFIG } from './config.js';
import { logError } from './logger.js';

const BASE = () => `https://api.telegram.org/bot${CONFIG.telegramToken}`;
const CHUNK = 3800;

/** Canal de mensajería del orquestador. Implementaciones: Telegram (producción)
 *  y ConsoleMessenger (pruebas locales con AI_HOME_CONSOLE=1). */
export interface Messenger {
  send(text: string): Promise<void>;
  sendTyping(): Promise<void>;
  setCommands(commands: { command: string; description: string }[]): Promise<void>;
  pollLoop(onMessage: (text: string) => void): Promise<void>;
  stop(): void;
}

interface TgUpdate {
  update_id: number;
  message?: { text?: string; chat: { id: number } };
  edited_message?: { text?: string; chat: { id: number } };
}

export class Telegram implements Messenger {
  private offset = 0;
  private stopped = false;

  async send(text: string): Promise<void> {
    for (let i = 0; i < text.length; i += CHUNK) {
      const chunk = text.slice(i, i + CHUNK);
      const ok = await this.api('sendMessage', {
        chat_id: CONFIG.telegramChatId,
        text: chunk,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
      if (!ok) {
        // reintenta sin Markdown (por si el texto rompe el parseo)
        await this.api('sendMessage', { chat_id: CONFIG.telegramChatId, text: chunk });
      }
    }
  }

  async sendTyping(): Promise<void> {
    await this.api('sendChatAction', { chat_id: CONFIG.telegramChatId, action: 'typing' });
  }

  async setCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.api('setMyCommands', { commands });
  }

  async pollLoop(onMessage: (text: string) => void): Promise<void> {
    while (!this.stopped) {
      try {
        const res = await fetch(`${BASE()}/getUpdates?timeout=50&offset=${this.offset}`, {
          signal: AbortSignal.timeout(65_000),
        });
        const data = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
        for (const upd of data.result ?? []) {
          this.offset = Math.max(this.offset, upd.update_id + 1);
          const msg = upd.message ?? upd.edited_message;
          if (!msg?.text) continue;
          if (String(msg.chat.id) !== String(CONFIG.telegramChatId)) continue; // ignora chats ajenos
          try {
            onMessage(msg.text);
          } catch (e) {
            logError('telegram.onMessage', e);
            void this.send(`⚠️ Error procesando tu mensaje: ${e instanceof Error ? e.message : e}`);
          }
        }
      } catch (e) {
        if (!(e instanceof Error && e.name === 'TimeoutError')) logError('telegram.poll', e);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async api(method: string, body: unknown): Promise<boolean> {
    try {
      const res = await fetch(`${BASE()}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const data = (await res.json()) as { ok: boolean; description?: string };
      if (!data.ok) logError(`telegram.${method}`, data.description ?? 'respuesta no ok');
      return data.ok;
    } catch (e) {
      logError(`telegram.${method}`, e);
      return false;
    }
  }
}
