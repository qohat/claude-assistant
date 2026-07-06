// Pool de tokens OAuth (cuentas Pro) con enfriamiento y fallback automático.
// Portado de code-assistant v1 (agent/runner.py).
import { CONFIG } from './config.js';

export const RATE_LIMIT_RE = new RegExp(
  'rate.?limit|usage limit|out of (?:tokens|credits)|too many requests|' +
  'limit reached|429|quota|insufficient.+credit|credit balance is too low',
  'i');
const RESET_RE = /reset[s]?\s+(?:at|in)\s+([^\n.]+)/i;
const EPOCH_RE = /\b(\d{9,11})\b/g; // algunos mensajes traen el epoch del reset
const DUR_H_RE = /(\d+)\s*h(?:our|r)?s?/i;
const DUR_M_RE = /(\d+)\s*m(?:in)?(?:ute)?s?/i;
const MAX_COOLDOWN_SEC = 6 * 3600; // tope de seguridad ante un parse erróneo

export interface TokenEntry { name: string; token: string }

class TokenPool {
  private tokens: TokenEntry[];
  private cooldownUntil = new Map<string, number>();

  constructor(pairs: [string, string][]) {
    // dedupe por valor (v1 tenía FALLBACK2 duplicado)
    const seen = new Set<string>();
    this.tokens = pairs
      .filter(([, t]) => (seen.has(t) ? false : (seen.add(t), true)))
      .map(([name, token]) => ({ name, token }));
  }

  /** Tokens cuyo enfriamiento ya pasó, en orden. Si todos agotados, los
   *  devuelve igual (un intento más; el límite se propagará al orquestador). */
  usable(): TokenEntry[] {
    const now = Date.now() / 1000;
    const free = this.tokens.filter(t => now >= (this.cooldownUntil.get(t.name) ?? 0));
    return free.length ? free : [...this.tokens];
  }

  markExhausted(name: string, waitSec: number): void {
    this.cooldownUntil.set(name, Date.now() / 1000 + waitSec);
  }

  /** Segundos hasta el reset que reporta claude, o null si no se infiere. */
  cooldownSecsFromText(text: string): number | null {
    if (!text) return null;
    const now = Date.now() / 1000;
    for (const m of text.matchAll(EPOCH_RE)) {
      const delta = Number(m[1]) - now;
      if (delta > 0 && delta <= MAX_COOLDOWN_SEC) return delta;
    }
    const hint = RESET_RE.exec(text)?.[1];
    if (hint) {
      let secs = 0;
      const h = DUR_H_RE.exec(hint);
      const mn = DUR_M_RE.exec(hint);
      if (h) secs += Number(h[1]) * 3600;
      if (mn) secs += Number(mn[1]) * 60;
      if (secs > 0 && secs <= MAX_COOLDOWN_SEC) return secs;
    }
    return null;
  }

  /** Segundos hasta que algún token vuelva a estar libre (0 si ya hay uno). */
  secondsUntilFree(): number {
    const now = Date.now() / 1000;
    if (this.tokens.some(t => now >= (this.cooldownUntil.get(t.name) ?? 0))) return 0;
    const waits = this.tokens
      .map(t => (this.cooldownUntil.get(t.name) ?? 0) - now)
      .filter(w => w > 0);
    return waits.length ? Math.min(...waits) : CONFIG.defaultCooldownSec;
  }

  status(): { name: string; freeInSec: number }[] {
    const now = Date.now() / 1000;
    return this.tokens.map(t => ({
      name: t.name,
      freeInSec: Math.max(0, (this.cooldownUntil.get(t.name) ?? 0) - now),
    }));
  }
}

export const tokenPool = new TokenPool(CONFIG.oauthTokens);
