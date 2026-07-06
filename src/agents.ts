// Registro de agentes. Agregar el agente #5 = una entrada aquí + una carpeta
// en templates/memory/<id>/ con su CLAUDE.md (setup.sh la siembra en el data dir).

export interface AgentDef {
  id: string;
  emoji: string;
  command: string;        // comando de Telegram que lo invoca
  aliases: string[];      // keywords para el enrutado barato (minúsculas)
  model: string;          // modelo por defecto (alias del CLI)
  description: string;    // se muestra en /agents y alimenta al clasificador
  extraDirs: string[];    // carpetas del data dir que usa además de su memoria
}

export const AGENTS: AgentDef[] = [
  {
    id: 'work-assistant',
    emoji: '💼',
    command: '/work',
    aliases: ['repo', 'repos', 'pr', 'issue', 'issues', 'código', 'codigo', 'deploy',
      'branch', 'rama', 'commit', 'merge', 'github', 'bug', 'clona', 'clonar', 'answeringit', 'answering-it'],
    model: 'sonnet',
    description: 'Trabajo y código: clona repos en work/, implementa, prueba y abre PRs con gh. Memoria: REPOS.md (repos registrados) y BRAIN.md (cómo trabajas).',
    extraDirs: ['work'],
  },
  {
    id: 'nutrition-assistant',
    emoji: '🥗',
    command: '/food',
    aliases: ['comida', 'comí', 'comi', 'almuerzo', 'desayuno', 'cena', 'dieta', 'nutrición',
      'nutricion', 'macros', 'proteína', 'proteina', 'entrené', 'entrene', 'entrenamiento',
      'gym', 'gimnasio', 'rutina', 'mercado', 'calorías', 'calorias'],
    model: 'sonnet',
    description: 'Nutrición y entrenamiento: plan alimenticio, plan de entrenamiento, tracking de comidas y rutina. Memoria: NUTRITION_PLAN.md, TRAINING_PLAN.md, ROUTINE.md.',
    extraDirs: [],
  },
  {
    id: 'financial-assistant',
    emoji: '💰',
    command: '/money',
    aliases: ['inversión', 'inversion', 'inversiones', 'finanzas', 'dinero', 'plata', 'acciones',
      'crypto', 'cripto', 'bitcoin', 'etf', 'portafolio', 'portfolio', 'mercado bursátil', 'ahorro', 'presupuesto'],
    model: 'sonnet',
    description: 'Finanzas e inversiones: portafolio, chequeos programados, análisis en investments/. Memoria: INVESTMENTS.md, INVESTMENTS_CHECK_SCHEDULE.md, BRAIN.md.',
    extraDirs: ['investments'],
  },
  {
    id: 'education-assistant',
    emoji: '📚',
    command: '/study',
    aliases: ['estudio', 'estudiar', 'certificación', 'certificacion', 'certificaciones', 'examen',
      'curso', 'cursos', 'aprender', 'aws', 'kubernetes', 'ckad', 'cka', 'plan de estudio'],
    model: 'sonnet',
    description: 'Estudio y certificaciones: plan de estudio, seguimiento de progreso, material en courses/. Memoria: EDUCATION_PLAN.md, CERTIFICATIONS.md, BRAIN.md.',
    extraDirs: ['courses'],
  },
];

export const byId = (id: string): AgentDef | undefined => AGENTS.find(a => a.id === id);

/** Resuelve un nombre laxo ("work", "/food", "education-assistant", "estudio"). */
export function resolveAgentName(name: string): AgentDef | undefined {
  const n = name.trim().toLowerCase().replace(/^\//, '');
  return AGENTS.find(a =>
    a.id === n || a.id.replace('-assistant', '') === n || a.command.slice(1) === n || a.aliases.includes(n));
}
