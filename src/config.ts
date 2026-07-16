// Configuración desde el entorno (EnvironmentFile=/etc/ai-home.env vía systemd).
import path from 'node:path';

const consoleMode = process.env.AI_HOME_CONSOLE === '1';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Falta la variable de entorno ${name}`);
    process.exit(1);
  }
  return v;
}

export const CONFIG = {
  consoleMode,
  // En modo consola (pruebas locales) el bot de Telegram no se usa.
  telegramToken: consoleMode ? (process.env.TELEGRAM_BOT_TOKEN ?? '') : required('TELEGRAM_BOT_TOKEN'),
  telegramChatId: consoleMode ? (process.env.TELEGRAM_CHAT_ID ?? '') : required('TELEGRAM_CHAT_ID'),
  dataDir: process.env.AI_HOME_DATA ?? '/ai-home',
  oauthTokens: [
    ['default', process.env.CLAUDE_CODE_OAUTH_TOKEN],
    ['fallback', process.env.CLAUDE_CODE_OAUTH_TOKEN_FALLBACK],
  ].filter((p): p is [string, string] => Boolean(p[1])),
  maxTurns: Number(process.env.AI_HOME_MAX_TURNS ?? 100),
  defaultCooldownSec: Number(process.env.AI_HOME_COOLDOWN_SEC ?? 900),
  longRunNoticeSec: Number(process.env.AI_HOME_LONG_RUN_NOTICE_SEC ?? 60),
  // Auto-continuar cuando un turno agota maxTurns (0 = deshabilitado).
  maxContinues: Number(process.env.AI_HOME_MAX_CONTINUES ?? 2),
  // Reintentos con backoff ante errores transitorios (red, 5xx, timeouts).
  transientRetries: Number(process.env.AI_HOME_TRANSIENT_RETRIES ?? 3),
  engramBin: process.env.AI_HOME_ENGRAM_BIN ?? 'engram',
};

export const memoryDir = (agentId: string) => path.join(CONFIG.dataDir, 'memory', agentId);
export const statePath = (name: string) => path.join(CONFIG.dataDir, 'state', name);
export const engramDataDir = () => path.join(CONFIG.dataDir, 'engram');
