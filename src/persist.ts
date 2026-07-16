// Escritor JSON atómico y serializado: cada archivo tiene su propia cadena
// de promesas, así dos escrituras concurrentes nunca se intercalan, y cada
// escritura es tmp + rename (nunca queda un archivo a medias).
import fs from 'node:fs/promises';
import { logError } from './logger.js';

export interface JsonWriter {
  /** Encola la escritura; resuelve cuando el archivo está en disco. */
  write(data: unknown): Promise<void>;
  /** Espera a que terminen todas las escrituras pendientes. */
  flush(): Promise<void>;
}

export function atomicJsonWriter(file: string): JsonWriter {
  let chain: Promise<void> = Promise.resolve();
  const write = (data: unknown): Promise<void> => {
    const json = JSON.stringify(data, null, 2);
    chain = chain.then(async () => {
      try {
        const tmp = `${file}.tmp`;
        await fs.writeFile(tmp, json);
        await fs.rename(tmp, file);
      } catch (e) {
        logError(`persist.${file}`, e);
      }
    });
    return chain;
  };
  return { write, flush: () => chain };
}

/** Lee y parsea un JSON; si está corrupto lo aparta como `.corrupt` (nunca lo
 *  pisa en silencio) y devuelve null. Si no existe, devuelve null sin ruido. */
export async function readJsonSafe<T>(file: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null; // no existe todavía: estado inicial
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    logError(`persist.read.${file}`, e);
    try {
      await fs.rename(file, `${file}.corrupt`);
    } catch { /* best effort */ }
    return null;
  }
}
