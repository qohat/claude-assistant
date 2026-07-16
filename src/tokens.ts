// Pool de tokens OAuth (cuentas Pro) con enfriamiento y fallback automático.
// Portado de code-assistant v1 (agent/runner.py).
import { CONFIG } from './config.js';

export const RATE_LIMIT_RE = new RegExp(
  'rate.?limit|usage limit|out of (?:tokens|credits)|too many requests|' +
  'limit reached|429|quota|insufficient.+credit|credit balance is too low',
  'i');
// Frases inequívocas del mensaje de límite que Claude Code inyecta como texto
// normal (subtype success, is_error=false), p.ej.
// "You've hit your session limit · resets 2:10am (UTC)".
export const LIMIT_TEXT_RE =
  /(?:you'?ve|I)\s+hit\s+(?:your|my)\s+(?:session|usage|weekly)\s+limit|(?:session|usage)\s+limit\s+reached/i;
// Errores transitorios que merecen retry con backoff (red caída, 5xx, timeouts).
// El rate-limit se evalúa ANTES que esto: un 429 rota de token, no reintenta.
export const TRANSIENT_RE = new RegExp(
  'ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|' +
  'fetch failed|network error|socket hang up|connection (?:closed|reset|refused)|' +
  'timed? ?out|aborted by server|' +
  '\\b(?:500|502|503|504|529)\\b|internal server error|bad gateway|service unavailable|' +
  'gateway timeout|overloaded|api_error',
  'i');
const RESET_RE = /reset[s]?\s+(?:at|in)\s+([^\n.]+)/i;
const RESET_CLOCK_RE = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?(utc)?\)?/i;
const EPOCH_RE = /\b(\d{9,11})\b/g; // algunos mensajes traen el epoch del reset
const DUR_H_RE = /(\d+)\s*h(?:our|r)?s?/i;
const DUR_M_RE = /(\d+)\s*m(?:in)?(?:ute)?s?/i;
const MAX_COOLDOWN_SEC = 6 * 3600; // tope de seguridad ante un parse erróneo

export interface TokenEntry { name: string; token: string }

export class TokenPool {
  private tokens: TokenEntry[];
  private cooldownUntil = new Map<string, number>();

  constructor(pairs: [string, string][], private clock: () => number = Date.now) {
    // dedupe por valor (v1 tenía FALLBACK2 duplicado)
    const seen = new Set<string>();
    this.tokens = pairs
      .filter(([, t]) => (seen.has(t) ? false : (seen.add(t), true)))
      .map(([name, token]) => ({ name, token }));
  }

  /** Tokens cuyo enfriamiento ya pasó, en orden. Si todos agotados, los
   *  devuelve igual (un intento más; el límite se propagará al orquestador). */
  usable(): TokenEntry[] {
    const now = this.clock() / 1000;
    const free = this.tokens.filter(t => now >= (this.cooldownUntil.get(t.name) ?? 0));
    return free.length ? free : [...this.tokens];
  }

  markExhausted(name: string, waitSec: number): void {
    this.cooldownUntil.set(name, this.clock() / 1000 + waitSec);
  }

  /** Segundos hasta el reset que reporta claude, o null si no se infiere. */
  cooldownSecsFromText(text: string): number | null {
    if (!text) return null;
    const now = this.clock() / 1000;
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
    // "resets 2:10am (UTC)" → próxima ocurrencia de esa hora UTC
    const clock = RESET_CLOCK_RE.exec(text);
    if (clock) {
      let hour = Number(clock[1]);
      if (clock[3]) hour = hour % 12 + (clock[3].toLowerCase() === 'pm' ? 12 : 0);
      const at = new Date(this.clock());
      at.setUTCHours(hour, Number(clock[2] ?? 0), 0, 0);
      let delta = at.getTime() / 1000 - now;
      if (delta < 0) delta += 24 * 3600;
      if (delta > 0 && delta <= MAX_COOLDOWN_SEC) return delta;
    }
    return null;
  }

  /** Segundos hasta que algún token vuelva a estar libre (0 si ya hay uno). */
  secondsUntilFree(): number {
    const now = this.clock() / 1000;
    if (this.tokens.some(t => now >= (this.cooldownUntil.get(t.name) ?? 0))) return 0;
    const waits = this.tokens
      .map(t => (this.cooldownUntil.get(t.name) ?? 0) - now)
      .filter(w => w > 0);
    return waits.length ? Math.min(...waits) : CONFIG.defaultCooldownSec;
  }

  status(): { name: string; freeInSec: number }[] {
    const now = this.clock() / 1000;
    return this.tokens.map(t => ({
      name: t.name,
      freeInSec: Math.max(0, (this.cooldownUntil.get(t.name) ?? 0) - now),
    }));
  }
}

export const tokenPool = new TokenPool(CONFIG.oauthTokens);
