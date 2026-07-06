// Orquestador: cola FIFO por agente (un run activo por agente; agentes
// distintos corren en paralelo), meta-comandos y avisos de tareas largas.
import { AGENTS, AgentDef, byId, resolveAgentName } from './agents.js';
import { CONFIG } from './config.js';
import { logError } from './logger.js';
import { route } from './router.js';
import { runAgentTurn } from './session.js';
import * as state from './state.js';
import { Telegram } from './telegram.js';
import { tokenPool } from './tokens.js';

interface AgentRuntime {
  queue: { text: string; modelOverride?: string }[];
  running: { startedAt: number; abort: AbortController; noticeSent: boolean } | null;
}

export class Orchestrator {
  private runtimes = new Map<string, AgentRuntime>();

  constructor(private tg: Telegram) {
    for (const a of AGENTS) this.runtimes.set(a.id, { queue: [], running: null });
  }

  /** Punto de entrada para mensajes de Telegram. */
  async handleMessage(text: string): Promise<void> {
    try {
      const r = await route(text);
      if (r.kind === 'meta') return void this.handleMeta(r.cmd, r.args);
      if (r.kind === 'ask') {
        return void this.tg.send(
          '🤔 No sé a qué asistente va dirigido. Usa un comando:\n' +
          AGENTS.map(a => `${a.command} — ${a.emoji} ${a.id.replace('-assistant', '')}`).join('\n'));
      }
      this.enqueue(r.agent, r.text, { modelOverride: r.modelOverride });
    } catch (e) {
      logError('orchestrator.handleMessage', e);
      void this.tg.send(`⚠️ Error interno: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Encola un turno para un agente (mensajes del usuario o del scheduler). */
  enqueue(agent: AgentDef, text: string, opts: { modelOverride?: string; source?: string } = {}): void {
    const rt = this.runtimes.get(agent.id)!;
    rt.queue.push({ text, modelOverride: opts.modelOverride });
    if (rt.running) {
      const mins = Math.round((Date.now() - rt.running.startedAt) / 60000);
      void this.tg.send(`⏳ ${agent.emoji} ${agent.id} está ocupado (${mins} min). Tu mensaje quedó en cola.`);
      return;
    }
    void this.drain(agent);
  }

  /** Procesa la cola del agente turno a turno. */
  private async drain(agent: AgentDef): Promise<void> {
    const rt = this.runtimes.get(agent.id)!;
    while (rt.queue.length) {
      const batch = rt.queue.splice(0, rt.queue.length);
      const prompt = batch.map(b => b.text).join('\n\n');
      const modelOverride = batch.map(b => b.modelOverride).filter(Boolean).pop();
      const abort = new AbortController();
      rt.running = { startedAt: Date.now(), abort, noticeSent: false };
      void this.tg.sendTyping();

      const notice = setInterval(() => {
        if (rt.running && !rt.running.noticeSent) {
          rt.running.noticeSent = true;
          void this.tg.send(`🔨 ${agent.emoji} ${agent.id} sigue trabajando…`);
        }
      }, CONFIG.longRunNoticeSec * 1000);

      try {
        const res = await runAgentTurn(agent, prompt, {
          modelOverride,
          abortController: abort,
          onTokenSwap: msg => void this.tg.send(msg),
        });
        if (res.reason === 'rate_limit') {
          const mins = Math.ceil(tokenPool.secondsUntilFree() / 60);
          rt.queue.unshift(...batch); // el turno vuelve a la cola
          void this.tg.send(`⛔ Sin cupo en todas las cuentas. Reintento en ~${mins} min.`);
          setTimeout(() => void this.drain(agent), tokenPool.secondsUntilFree() * 1000 + 5000);
          break;
        }
        if (res.reason === 'aborted') {
          void this.tg.send(`🛑 ${agent.emoji} ${agent.id}: tarea detenida.`);
        } else {
          const prefix = res.ok ? '' : '⚠️ ';
          void this.tg.send(`${agent.emoji} ${prefix}${res.text || '(sin respuesta)'}`);
        }
      } catch (e) {
        logError(`orchestrator.${agent.id}`, e);
        void this.tg.send(`⚠️ ${agent.emoji} ${agent.id} falló: ${e instanceof Error ? e.message : e}`);
      } finally {
        clearInterval(notice);
        rt.running = null;
      }
    }
  }

  // ------------------------------------------------------- meta-comandos
  private handleMeta(cmd: string, args: string): void {
    switch (cmd) {
      case 'switched': {
        const a = byId(args)!;
        void this.tg.send(`${a.emoji} Ahora hablas con *${a.id}*.`);
        return;
      }
      case 'agents':
        void this.tg.send('🤖 *Asistentes*\n\n' +
          AGENTS.map(a => `${a.command} ${a.emoji} *${a.id}*\n${a.description}`).join('\n\n'));
        return;
      case 'status': {
        const lines = AGENTS.map(a => {
          const rt = this.runtimes.get(a.id)!;
          const st = rt.running
            ? `🔨 trabajando (${Math.round((Date.now() - rt.running.startedAt) / 60000)} min)`
            : 'idle';
          const q = rt.queue.length ? ` · cola: ${rt.queue.length}` : '';
          const s = state.getSession(a.id) ? ' · sesión activa' : ' · sin sesión';
          return `${a.emoji} ${a.id}: ${st}${q}${s}`;
        });
        const toks = tokenPool.status()
          .map(t => `«${t.name}»${t.freeInSec > 0 ? ` (enfriando ${Math.ceil(t.freeInSec / 60)} min)` : ' ✅'}`)
          .join(' · ');
        const active = state.getActiveAgent() ?? 'ninguno';
        void this.tg.send(`📊 *Estado*\n${lines.join('\n')}\n\nTokens: ${toks}\nAgente activo: ${active}`);
        return;
      }
      case 'new': {
        const agent = resolveAgentName(args);
        if (!agent) return void this.tg.send('Uso: `/new <agente>` (ej. `/new work`)');
        state.clearSession(agent.id);
        void this.tg.send(`🆕 ${agent.emoji} Sesión de ${agent.id} reiniciada. Su memoria .md sigue intacta.`);
        return;
      }
      case 'stop': {
        const agent = resolveAgentName(args);
        if (!agent) return void this.tg.send('Uso: `/stop <agente>`');
        const rt = this.runtimes.get(agent.id)!;
        if (rt.running) {
          rt.running.abort.abort();
          rt.queue.length = 0;
        } else {
          void this.tg.send(`${agent.emoji} ${agent.id} no está haciendo nada.`);
        }
        return;
      }
      case 'help':
      case 'start':
        void this.tg.send(
          '🏠 *ai-home* — tus asistentes por Telegram\n\n' +
          AGENTS.map(a => `${a.command} — ${a.emoji} ${a.description.split(':')[0]}`).join('\n') +
          '\n\n/status — estado · /agents — detalle\n/new <agente> — nueva sesión · /stop <agente> — detener' +
          '\n\nEscribe libremente: enruto tu mensaje al asistente correcto. ' +
          'Di "usa opus" en el mensaje para cambiar de modelo en ese turno.');
        return;
    }
  }
}
