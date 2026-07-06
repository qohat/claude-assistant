// Log solo de errores + aviso best-effort a Telegram.
import fs from 'node:fs';
import path from 'node:path';
import { statePath } from './config.js';

let alert: ((text: string) => void) | null = null;

/** Registra la función que envía avisos (Telegram). */
export function setAlert(fn: (text: string) => void): void {
  alert = fn;
}

export function logError(scope: string, err: unknown): void {
  const line = `${new Date().toISOString()} [${scope}] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`;
  try {
    const file = statePath(path.join('logs', 'error.log'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line);
  } catch {
    console.error(line);
  }
}

export function notifyError(scope: string, err: unknown, userText?: string): void {
  logError(scope, err);
  if (alert && userText) {
    try { alert(userText); } catch { /* best effort */ }
  }
}
