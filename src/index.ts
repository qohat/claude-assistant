// ai-home: orquestador multi-agente por Telegram sobre el Claude Agent SDK.
import { AGENTS } from './agents.js';
import { logError, setAlert } from './logger.js';
import { Orchestrator } from './orchestrator.js';
import { Scheduler } from './scheduler.js';
import { Telegram } from './telegram.js';

const tg = new Telegram();
setAlert(text => void tg.send(text));

const orchestrator = new Orchestrator(tg);
new Scheduler(orchestrator).start();

for (const sig of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(sig, (err: unknown) => {
    logError(sig, err);
    // aviso best-effort y salida: systemd (Restart=always) nos revive
    void tg.send(`💥 ai-home se reinició: ${err instanceof Error ? err.message : String(err)}`)
      .finally(() => process.exit(1));
    setTimeout(() => process.exit(1), 5000);
  });
}

await tg.setCommands([
  ...AGENTS.map(a => ({ command: a.command.slice(1), description: `${a.emoji} ${a.description.split(':')[0]}` })),
  { command: 'status', description: '📊 Estado de agentes y tokens' },
  { command: 'agents', description: '🤖 Lista de asistentes' },
  { command: 'new', description: '🆕 Nueva sesión para un agente' },
  { command: 'stop', description: '🛑 Detener la tarea de un agente' },
  { command: 'help', description: 'ℹ️ Ayuda' },
]);

await tg.send('🏠 ai-home en línea. Escribe /help para ver los asistentes.');
await tg.pollLoop(text => void orchestrator.handleMessage(text));
