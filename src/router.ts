// Enruta cada mensaje: meta-comandos → comando de agente → keywords →
// clasificador haiku → agente activo (sticky) → preguntar.
import { AGENTS, AgentDef, resolveAgentName } from './agents.js';
import { oneShot } from './session.js';
import { store } from './state.js';

export type Route =
  | { kind: 'meta'; cmd: string; args: string }
  | { kind: 'agent'; agent: AgentDef; text: string; modelOverride?: string }
  | { kind: 'ask' };

const META = ['status', 'agents', 'new', 'stop', 'help', 'start'];
const MODEL_RE = /\b(?:usa|usando|con(?:\s+el)?(?:\s+modelo)?)\s+(opus|sonnet|haiku)\b/i;

// Dependencias inyectables para tests: clasificador y estado sticky.
export interface RouteDeps {
  classify?: (prompt: string) => Promise<string | null>;
  state?: { getActiveAgent(): string | null; setActiveAgent(id: string): void };
}

export async function route(text: string, deps: RouteDeps = {}): Promise<Route> {
  const classify = deps.classify ?? oneShot;
  const state = deps.state ?? store;
  const trimmed = text.trim();

  // 1. comandos
  const cmdMatch = /^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(trimmed);
  if (cmdMatch) {
    const [, cmd, args] = cmdMatch;
    if (META.includes(cmd.toLowerCase())) return { kind: 'meta', cmd: cmd.toLowerCase(), args: args.trim() };
    const agent = resolveAgentName(cmd);
    if (agent) {
      state.setActiveAgent(agent.id);
      if (!args.trim()) return { kind: 'meta', cmd: 'switched', args: agent.id };
      return withModel(agent, args.trim());
    }
    return { kind: 'ask' };
  }

  // 2. keywords del registro
  const lower = trimmed.toLowerCase();
  const scored = AGENTS
    .map(a => ({ a, hits: a.aliases.filter(k => lower.includes(k)).length }))
    .filter(s => s.hits > 0)
    .sort((x, y) => y.hits - x.hits);
  if (scored.length && (scored.length === 1 || scored[0].hits > scored[1].hits)) {
    state.setActiveAgent(scored[0].a.id);
    return withModel(scored[0].a, trimmed);
  }

  // 3. clasificador one-shot (haiku)
  const catalog = AGENTS.map(a => `- ${a.id}: ${a.description}`).join('\n');
  const answer = await classify(
    `Clasifica a qué asistente va dirigido este mensaje del usuario.\n` +
    `Asistentes:\n${catalog}\n\nMensaje: """${trimmed.slice(0, 500)}"""\n\n` +
    `Responde SOLO el id del asistente (ej. work-assistant) o "ninguno".`);
  if (answer) {
    const agent = resolveAgentName(answer.split(/\s/)[0] ?? '');
    if (agent) {
      state.setActiveAgent(agent.id);
      return withModel(agent, trimmed);
    }
  }

  // 4. sticky: último agente activo
  const activeId = state.getActiveAgent();
  const active = activeId ? AGENTS.find(a => a.id === activeId) : undefined;
  if (active) return withModel(active, trimmed);

  return { kind: 'ask' };
}

function withModel(agent: AgentDef, text: string): Route {
  const m = MODEL_RE.exec(text);
  return { kind: 'agent', agent, text, modelOverride: m?.[1]?.toLowerCase() };
}
