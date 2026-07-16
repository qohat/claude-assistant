// Scheduler proactivo: jobs cron de state/schedules.json → turnos de agente.
// Los propios agentes pueden editar el archivo (documentado en su CLAUDE.md);
// se recarga solo al detectar cambios.
import fs from 'node:fs';
import cron, { ScheduledTask } from 'node-cron';
import { resolveAgentName } from './agents.js';
import { statePath } from './config.js';
import { logError, notifyError } from './logger.js';
import { Orchestrator } from './orchestrator.js';

interface Job {
  id: string;
  agent: string;
  cron: string;
  prompt: string;
  enabled: boolean;
}

export class Scheduler {
  private tasks: ScheduledTask[] = [];
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(private orchestrator: Orchestrator) {}

  start(): void {
    this.load();
    try {
      fs.watch(statePath('schedules.json'), () => {
        // debounce: los editores/agentes disparan varios eventos por guardado
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.load(), 1500);
      });
    } catch (e) {
      logError('scheduler.watch', e);
    }
  }

  private load(retrying = false): void {
    // Parsear ANTES de destruir las tareas actuales: un JSON inválido (o un
    // guardado a medias de un agente) no debe dejar el scheduler vacío.
    let jobs: Job[];
    try {
      jobs = JSON.parse(fs.readFileSync(statePath('schedules.json'), 'utf8')) as Job[];
      if (!Array.isArray(jobs)) throw new Error('schedules.json no es un array');
    } catch (e) {
      if (!retrying) {
        // puede ser una escritura en curso: reintenta una vez a los 2s
        setTimeout(() => this.load(true), 2000);
      } else {
        notifyError('scheduler.load', e, '⚠️ schedules.json inválido; conservo los jobs anteriores.');
      }
      return;
    }
    for (const t of this.tasks) t.stop();
    this.tasks = [];
    for (const job of jobs) {
      if (!job.enabled) continue;
      const agent = resolveAgentName(job.agent);
      if (!agent || !cron.validate(job.cron)) {
        notifyError('scheduler.job', `job «${job.id}» inválido (agente o cron)`,
          `⚠️ Job programado «${job.id}» inválido; lo ignoro.`);
        continue;
      }
      this.tasks.push(cron.schedule(job.cron, () => {
        this.orchestrator.enqueue(agent, `[Tarea programada «${job.id}»] ${job.prompt}`, { source: 'scheduler' });
      }));
    }
  }
}
