// Motor de sesiones: un turno de un agente = query() del Agent SDK con la
// sesión resumible del agente, su carpeta de memoria como cwd y autonomía total.
// Rota tokens del pool ante límite de uso y reintenta el mismo turno.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AgentDef } from './agents.js';
import { CONFIG, memoryDir } from './config.js';
import { logError } from './logger.js';
import * as state from './state.js';
import { LIMIT_TEXT_RE, RATE_LIMIT_RE, tokenPool } from './tokens.js';

export interface TurnResult {
  ok: boolean;
  reason: 'ok' | 'rate_limit' | 'error' | 'aborted';
  text: string;
  tokenName: string;
  numTurns: number;
  durationMs: number;
  resetsAtSec?: number; // epoch del reset reportado por el rate_limit_event
}

export interface TurnOpts {
  modelOverride?: string;
  onTokenSwap?: (msg: string) => void; // aviso a Telegram al rotar de cuenta
  abortController?: AbortController;
}

export async function runAgentTurn(agent: AgentDef, prompt: string, opts: TurnOpts = {}): Promise<TurnResult> {
  const tokens = tokenPool.usable();
  let last: TurnResult | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const { name, token } = tokens[i];
    const res = await runOnce(agent, prompt, token, name, opts);
    if (res.reason !== 'rate_limit') return res;
    const fromEvent = res.resetsAtSec ? res.resetsAtSec - Date.now() / 1000 : null;
    const secs = (fromEvent && fromEvent > 0 ? fromEvent : null)
      ?? tokenPool.cooldownSecsFromText(res.text)
      ?? CONFIG.defaultCooldownSec;
    tokenPool.markExhausted(name, secs);
    last = res;
    if (i + 1 < tokens.length) {
      opts.onTokenSwap?.(
        `🔁 Token «${name}» sin cupo (libre en ~${Math.round(secs / 60)} min). ` +
        `Cambio al token «${tokens[i + 1].name}» y reintento.`);
    }
  }
  return last ?? { ok: false, reason: 'error', text: 'sin tokens utilizables', tokenName: 'env', numTurns: 0, durationMs: 0 };
}

async function runOnce(agent: AgentDef, prompt: string, token: string, tokenName: string, opts: TurnOpts): Promise<TurnResult> {
  const start = Date.now();
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token };
  delete env.ANTHROPIC_API_KEY; // que una API key no pise el OAuth (lección de v1)
  const resume = state.getSession(agent.id);

  try {
    const q = query({
      prompt,
      options: {
        cwd: memoryDir(agent.id),
        model: opts.modelOverride ?? agent.model,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        resume,
        settingSources: ['project'],           // carga el CLAUDE.md del agente
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        maxTurns: CONFIG.maxTurns,
        env,
        abortController: opts.abortController,
      },
    });

    // El límite de suscripción puede llegar como evento tipado (lo fiable) o
    // solo como texto inyectado en un result "success" (visto en producción:
    // "You've hit your session limit · resets 2:10am (UTC)").
    let limitResetsAt: number | undefined;
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        state.setSession(agent.id, msg.session_id);
      } else if (msg.type === 'rate_limit_event') {
        if (msg.rate_limit_info.status === 'rejected') {
          limitResetsAt = msg.rate_limit_info.resetsAt ?? limitResetsAt;
        }
      } else if (msg.type === 'result') {
        const text = msg.subtype === 'success'
          ? msg.result
          : (msg.errors?.join('\n') || `terminó con ${msg.subtype}`);
        const isLimit = limitResetsAt !== undefined
          || LIMIT_TEXT_RE.test(text)
          || (msg.is_error && RATE_LIMIT_RE.test(text));
        return {
          ok: !msg.is_error && !isLimit,
          reason: isLimit ? 'rate_limit' : msg.is_error ? 'error' : 'ok',
          text: text.slice(0, 8000),
          tokenName,
          numTurns: msg.num_turns,
          durationMs: msg.duration_ms,
          resetsAtSec: limitResetsAt,
        };
      }
    }
    return { ok: false, reason: 'error', text: 'la sesión terminó sin resultado', tokenName, numTurns: 0, durationMs: Date.now() - start };
  } catch (e) {
    if (opts.abortController?.signal.aborted) {
      return { ok: false, reason: 'aborted', text: 'detenido por el usuario', tokenName, numTurns: 0, durationMs: Date.now() - start };
    }
    const text = e instanceof Error ? e.message : String(e);
    logError(`session.${agent.id}`, e);
    return {
      ok: false,
      reason: RATE_LIMIT_RE.test(text) ? 'rate_limit' : 'error',
      text: text.slice(0, 1200),
      tokenName,
      numTurns: 0,
      durationMs: Date.now() - start,
    };
  }
}

/** Llamada one-shot sin herramientas ni persistencia (clasificador de enrutado). */
export async function oneShot(prompt: string, model = 'haiku'): Promise<string | null> {
  const token = tokenPool.usable()[0];
  if (!token) return null;
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token.token };
  delete env.ANTHROPIC_API_KEY;
  try {
    const q = query({
      prompt,
      options: {
        model,
        maxTurns: 1,
        allowedTools: [],
        settingSources: [],
        systemPrompt: 'Responde únicamente lo que se te pide, sin explicaciones.',
        persistSession: false,
        env,
      },
    });
    for await (const msg of q) {
      if (msg.type === 'result') return msg.subtype === 'success' ? msg.result.trim() : null;
    }
  } catch (e) {
    logError('session.oneShot', e);
  }
  return null;
}
