// Estado persistente pequeño: sesiones por agente + agente activo (sticky).
// Escritura atómica: tmp + rename.
import fs from 'node:fs';
import { statePath } from './config.js';
import { logError } from './logger.js';

interface SessionEntry { sessionId: string; updatedAt: string }
interface StateFile { sessions: Record<string, SessionEntry>; activeAgent: string | null }

const FILE = () => statePath('sessions.json');

function load(): StateFile {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8')) as StateFile;
  } catch {
    return { sessions: {}, activeAgent: null };
  }
}

function save(data: StateFile): void {
  try {
    const tmp = FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, FILE());
  } catch (e) {
    logError('state.save', e);
  }
}

export function getSession(agentId: string): string | undefined {
  return load().sessions[agentId]?.sessionId;
}

export function setSession(agentId: string, sessionId: string): void {
  const data = load();
  data.sessions[agentId] = { sessionId, updatedAt: new Date().toISOString() };
  save(data);
}

export function clearSession(agentId: string): void {
  const data = load();
  delete data.sessions[agentId];
  save(data);
}

export function getActiveAgent(): string | null {
  return load().activeAgent;
}

export function setActiveAgent(agentId: string): void {
  const data = load();
  data.activeAgent = agentId;
  save(data);
}
