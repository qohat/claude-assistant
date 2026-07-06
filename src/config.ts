// Configuración desde el entorno (EnvironmentFile=/etc/ai-home.env vía systemd).
import path from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Falta la variable de entorno ${name}`);
    process.exit(1);
  }
  return v;
}

export const CONFIG = {
  telegramToken: required('TELEGRAM_BOT_TOKEN'),
  telegramChatId: required('TELEGRAM_CHAT_ID'),
  dataDir: process.env.AI_HOME_DATA ?? '/ai-home',
  oauthTokens: [
    ['default', process.env.CLAUDE_CODE_OAUTH_TOKEN],
    ['fallback', process.env.CLAUDE_CODE_OAUTH_TOKEN_FALLBACK],
  ].filter((p): p is [string, string] => Boolean(p[1])),
  maxTurns: Number(process.env.AI_HOME_MAX_TURNS ?? 100),
  defaultCooldownSec: Number(process.env.AI_HOME_COOLDOWN_SEC ?? 900),
  longRunNoticeSec: Number(process.env.AI_HOME_LONG_RUN_NOTICE_SEC ?? 60),
};

export const memoryDir = (agentId: string) => path.join(CONFIG.dataDir, 'memory', agentId);
export const statePath = (name: string) => path.join(CONFIG.dataDir, 'state', name);
