// Orquestador: cola FIFO por agente (un run activo por agente; agentes
// distintos corren en paralelo), meta-comandos y avisos de tareas largas.
// La ENTRADA se procesa serializada (cadena de promesas): dos mensajes
// seguidos se rutean en orden aunque el clasificador haiku tarde; los runs
// de agentes sí corren en paralelo. Cada mutación de cola se snapshotea en
// el journal (state/queue.json) para sobrevivir crashes y reinicios.
import { AGENTS, AgentDef, byId, resolveAgentName } from './agents.js';
import { CONFIG } from './config.js';
import { QueueItem, QueueJournal } from './journal.js';
import { logError } from './logger.js';
import { route } from './router.js';
import { runAgentTurn } from './session.js';
import { store as state } from './state.js';
import { Messenger } from './telegram.js';
import { tokenPool } from './tokens.js';

interface AgentRuntime {
  queue: QueueItem[];
  running: { startedAt: number; abort: AbortController; noticeSent: boolean; items: QueueItem[] } | null;
}

// Se prefija al primer turno de un agente sin sesión previa: dispara el
// onboarding definido en su CLAUDE.md si su memoria engram está vacía.
const FIRST_SESSION_HINT =
  '[Primera sesión] No tienes sesión previa. Antes de responder, revisa tu memoria engram con mem_context; ' +
  'si está vacía o no tiene una memoria de tipo "onboarding", sigue la sección «Onboarding (primera vez)» de tu CLAUDE.md.';

const CONTINUE_PROMPT =
  'Agotaste el límite de turnos. Continúa la tarea anterior desde donde quedaste: recupera tu último checkpoint ' +
  'con mem_search (tipo "progreso") si lo necesitas, termina lo pendiente y entrega el resultado final.';

export class Orchestrator {
  private runtimes = new Map<string, AgentRuntime>();
  private inbound: Promise<void> = Promise.resolve();
  private journal: QueueJournal;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(private tg: Messenger, journal?: QueueJournal) {
    this.journal = journal ?? new QueueJournal();
    for (const a of AGENTS) this.runtimes.set(a.id, { queue: [], running: null });
  }

  /** Punto de entrada para mensajes del usuario. Serializa el ruteo: los
   *  mensajes se procesan en el orden en que llegan. */
  handleMessage(text: string): Promise<void> {
    this.inbound = this.inbound.then(() => this.routeAndDispatch(text)).catch(e => {
      logError('orchestrator.handleMessage', e);
      void this.tg.send(`⚠️ Error interno: ${e instanceof Error ? e.message : e}`);
    });
    return this.inbound;
  }

  private async routeAndDispatch(text: string): Promise<void> {
    const r = await route(text);
    if (r.kind === 'meta') return void this.handleMeta(r.cmd, r.args);
    if (r.kind === 'ask') {
      return void this.tg.send(
        '🤔 No sé a qué asistente va dirigido. Usa un comando:\n' +
        AGENTS.map(a => `${a.command} — ${a.emoji} ${a.id.replace('-assistant', '')}`).join('\n'));
    }
    this.enqueue(r.agent, r.text, { modelOverride: r.modelOverride });
  }

  /** Encola un turno para un agente (mensajes del usuario o del scheduler). */
  enqueue(agent: AgentDef, text: string, opts: { modelOverride?: string; source?: string } = {}): void {
    if (this.shuttingDown) return;
    const rt = this.runtimes.get(agent.id)!;
    rt.queue.push({ text, modelOverride: opts.modelOverride, source: opts.source, enqueuedAt: new Date().toISOString() });
    this.snapshot(agent.id);
    if (rt.running) {
      const mins = Math.round((Date.now() - rt.running.startedAt) / 60000);
      void this.tg.send(`⏳ ${agent.emoji} ${agent.id} está ocupado (${mins} min). Tu mensaje quedó en cola.`);
      return;
    }
    void this.drain(agent);
  }

  /** Re-encola lo que el journal guardó antes del último apagado/crash. */
  async restore(): Promise<void> {
    const restored = await this.journal.restore();
    let total = 0;
    const agents: AgentDef[] = [];
    for (const [agentId, items] of restored) {
      const agent = byId(agentId);
      if (!agent) continue;
      this.runtimes.get(agentId)!.queue.push(...items);
      this.snapshot(agentId);
      total += items.length;
      agents.push(agent);
    }
    if (!total) return;
    void this.tg.send(`🔁 Reanudo ${total} tarea(s) pendiente(s) de antes del reinicio: ` +
      agents.map(a => `${a.emoji} ${a.id}`).join(', '));
    for (const agent of agents) void this.drain(agent);
  }

  /** Apagado ordenado (SIGTERM/SIGINT): aborta runs, pasa inflight→pending
   *  en el journal y espera a que el estado llegue a disco. Todos los
   *  callers comparten la misma promesa: nadie hace exit antes del flush. */
  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.doShutdown();
    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const [agentId, rt] of this.runtimes) {
      if (rt.running) {
        rt.running.abort.abort();
        rt.queue.unshift(...rt.running.items);
        rt.running = null;
      }
      this.snapshot(agentId);
    }
    await this.journal.flush();
    await state.flush();
  }

  private snapshot(agentId: string): void {
    const rt = this.runtimes.get(agentId)!;
    this.journal.snapshot(agentId, rt.queue, rt.running?.items ?? []);
  }

  /** Procesa la cola del agente turno a turno. */
  private async drain(agent: AgentDef): Promise<void> {
    const rt = this.runtimes.get(agent.id)!;
    while (rt.queue.length && !this.shuttingDown) {
      const batch = rt.queue.splice(0, rt.queue.length);
      let prompt = batch.map(b => b.text).join('\n\n');
      if (!state.getSession(agent.id)) prompt = `${FIRST_SESSION_HINT}\n\n${prompt}`;
      const modelOverride = batch.map(b => b.modelOverride).filter(Boolean).pop();
      const abort = new AbortController();
      rt.running = { startedAt: Date.now(), abort, noticeSent: false, items: batch };
      this.snapshot(agent.id);
      void this.tg.sendTyping();

      const notice = setInterval(() => {
        if (rt.running && !rt.running.noticeSent) {
          rt.running.noticeSent = true;
          void this.tg.send(`🔨 ${agent.emoji} ${agent.id} sigue trabajando…`);
        }
      }, CONFIG.longRunNoticeSec * 1000);

      try {
        const turnOpts = {
          modelOverride,
          abortController: abort,
          onTokenSwap: (msg: string) => void this.tg.send(msg),
          onRetry: (msg: string) => void this.tg.send(`${agent.emoji} ${msg}`),
        };
        let res = await runAgentTurn(agent, prompt, turnOpts);

        // maxTurns agotado: auto-continuar sobre la misma sesión, acotado.
        let continues = 0;
        while (res.subtype === 'error_max_turns' && continues < CONFIG.maxContinues
               && !abort.signal.aborted && !this.shuttingDown) {
          continues++;
          void this.tg.send(`⏭️ ${agent.emoji} ${agent.id} agotó el límite de turnos; continúo (${continues}/${CONFIG.maxContinues}).`);
          res = await runAgentTurn(agent, CONTINUE_PROMPT, turnOpts);
        }

        if (res.reason === 'rate_limit') {
          const mins = Math.ceil(tokenPool.secondsUntilFree() / 60);
          rt.queue.unshift(...batch); // el turno vuelve a la cola
          rt.running = null;
          this.snapshot(agent.id);
          void this.tg.send(`⛔ Sin cupo en todas las cuentas. Reintento en ~${mins} min.`);
          setTimeout(() => void this.drain(agent), tokenPool.secondsUntilFree() * 1000 + 5000);
          break;
        }
        if (res.reason === 'aborted') {
          if (!this.shuttingDown) void this.tg.send(`🛑 ${agent.emoji} ${agent.id}: tarea detenida.`);
        } else if (res.subtype === 'error_max_turns') {
          void this.tg.send(`⚠️ ${agent.emoji} ${agent.id} agotó el límite de turnos ${CONFIG.maxContinues} veces seguidas; lo dejo ahí. Escríbele para retomar.`);
        } else {
          const prefix = res.ok ? '' : '⚠️ ';
          void this.tg.send(`${agent.emoji} ${prefix}${res.text || '(sin respuesta)'}`);
        }
      } catch (e) {
        logError(`orchestrator.${agent.id}`, e);
        void this.tg.send(`⚠️ ${agent.emoji} ${agent.id} falló: ${e instanceof Error ? e.message : e}`);
      } finally {
        clearInterval(notice);
        if (rt.running) {
          rt.running = null;
          this.snapshot(agent.id);
        }
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
        void this.tg.send(`🆕 ${agent.emoji} Sesión de ${agent.id} reiniciada. Su memoria engram sigue intacta.`);
        return;
      }
      case 'stop': {
        const agent = resolveAgentName(args);
        if (!agent) return void this.tg.send('Uso: `/stop <agente>`');
        const rt = this.runtimes.get(agent.id)!;
        if (rt.running) {
          rt.running.abort.abort();
          rt.running = null;
          rt.queue.length = 0;
          this.snapshot(agent.id);
        } else if (rt.queue.length) {
          rt.queue.length = 0;
          this.snapshot(agent.id);
          void this.tg.send(`${agent.emoji} ${agent.id}: cola vaciada.`);
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
