// Journal de colas: snapshot de pending+inflight por agente en cada mutación
// (state/queue.json). Tras un crash/restart, restore() devuelve lo que estaba
// pendiente o en curso para re-encolarlo.
import { statePath } from './config.js';
import { atomicJsonWriter, JsonWriter, readJsonSafe } from './persist.js';

export interface QueueItem {
  text: string;
  modelOverride?: string;
  source?: string;
  enqueuedAt: string;
}

type JournalFile = Record<string, { pending: QueueItem[]; inflight: QueueItem[] }>;

export class QueueJournal {
  private data: JournalFile = {};
  private writer: JsonWriter;

  constructor(private file = statePath('queue.json')) {
    this.writer = atomicJsonWriter(this.file);
  }

  /** Reemplaza el snapshot de un agente y lo persiste. */
  snapshot(agentId: string, pending: QueueItem[], inflight: QueueItem[]): void {
    if (!pending.length && !inflight.length) {
      delete this.data[agentId];
    } else {
      this.data[agentId] = { pending: [...pending], inflight: [...inflight] };
    }
    void this.writer.write(this.data);
  }

  /** Carga el journal de un arranque anterior: inflight primero (estaba a
   *  medias), luego pending. Tolera archivo ausente o corrupto. */
  async restore(): Promise<Map<string, QueueItem[]>> {
    const stored = await readJsonSafe<JournalFile>(this.file);
    const out = new Map<string, QueueItem[]>();
    if (!stored || typeof stored !== 'object') return out;
    for (const [agentId, entry] of Object.entries(stored)) {
      const items = [...(entry?.inflight ?? []), ...(entry?.pending ?? [])]
        .filter((i): i is QueueItem => Boolean(i && typeof i.text === 'string' && i.text));
      if (items.length) out.set(agentId, items);
    }
    this.data = {}; // el orquestador re-encola y vuelve a snapshotear
    return out;
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }
}
