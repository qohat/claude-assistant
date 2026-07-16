// Estado persistente pequeño: sesiones por agente + agente activo (sticky).
// Se carga UNA vez al arrancar y vive en memoria; las escrituras van por el
// escritor atómico serializado (dos agentes terminando a la vez ya no se
// pisan el session id, y un archivo corrupto se aparta en vez de perderse).
import fs from 'node:fs';
import { statePath } from './config.js';
import { logError } from './logger.js';
import { atomicJsonWriter, JsonWriter } from './persist.js';

interface SessionEntry { sessionId: string; updatedAt: string }
interface StateFile { sessions: Record<string, SessionEntry>; activeAgent: string | null }

export class StateStore {
  private data: StateFile;
  private writer: JsonWriter;

  constructor(private file = statePath('sessions.json')) {
    this.writer = atomicJsonWriter(this.file);
    this.data = this.loadSync();
  }

  private loadSync(): StateFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return { sessions: {}, activeAgent: null }; // no existe: estado inicial
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StateFile>;
      return { sessions: parsed.sessions ?? {}, activeAgent: parsed.activeAgent ?? null };
    } catch (e) {
      // corrupto: apartar, nunca pisar (podría recuperarse a mano)
      logError('state.load', e);
      try { fs.renameSync(this.file, `${this.file}.corrupt`); } catch { /* best effort */ }
      return { sessions: {}, activeAgent: null };
    }
  }

  private persist(): void {
    void this.writer.write(this.data);
  }

  getSession(agentId: string): string | undefined {
    return this.data.sessions[agentId]?.sessionId;
  }

  setSession(agentId: string, sessionId: string): void {
    this.data.sessions[agentId] = { sessionId, updatedAt: new Date().toISOString() };
    this.persist();
  }

  clearSession(agentId: string): void {
    delete this.data.sessions[agentId];
    this.persist();
  }

  getActiveAgent(): string | null {
    return this.data.activeAgent;
  }

  setActiveAgent(agentId: string): void {
    this.data.activeAgent = agentId;
    this.persist();
  }

  /** Espera a que las escrituras pendientes lleguen a disco (shutdown/tests). */
  flush(): Promise<void> {
    return this.writer.flush();
  }
}

export const store = new StateStore();
