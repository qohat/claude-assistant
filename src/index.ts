// ai-home: orquestador multi-agente por Telegram sobre el Claude Agent SDK.
// Con AI_HOME_CONSOLE=1 corre contra stdin/stdout (pruebas sin bot real).
import { AGENTS } from './agents.js';
import { CONFIG } from './config.js';
import { ConsoleMessenger } from './console-messenger.js';
import { logError, setAlert } from './logger.js';
import { Orchestrator } from './orchestrator.js';
import { Scheduler } from './scheduler.js';
import { Messenger, Telegram } from './telegram.js';

const tg: Messenger = CONFIG.consoleMode ? new ConsoleMessenger() : new Telegram();
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

// Apagado ordenado: systemd manda SIGTERM (TimeoutStopSec=30). Los runs en
// curso se abortan y vuelven al journal como pending para el próximo arranque.
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    tg.stop();
    orchestrator.shutdown()
      .catch(e => logError('shutdown', e))
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 25_000);
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

await orchestrator.restore(); // re-encola lo que quedó pendiente en el journal

if (!CONFIG.consoleMode) await tg.send('🏠 ai-home en línea. Escribe /help para ver los asistentes.');
await tg.pollLoop(text => void orchestrator.handleMessage(text));

// El pollLoop solo termina en modo consola (EOF de stdin): apagado ordenado.
await orchestrator.shutdown().catch(e => logError('shutdown', e));
process.exit(0);
