// Tests de QueueJournal: snapshot en cada mutación y restore tras "crash".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AI_HOME_CONSOLE = '1';
process.env.AI_HOME_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aihome-journal-'));
fs.mkdirSync(path.join(process.env.AI_HOME_DATA, 'state', 'logs'), { recursive: true });

const { QueueJournal } = await import('../dist/journal.js');

const tmpFile = () => path.join(process.env.AI_HOME_DATA, 'state', `q-${Math.random().toString(36).slice(2)}.json`);
const item = (text, source) => ({ text, source, enqueuedAt: new Date().toISOString() });

test('snapshot + restore: inflight vuelve primero, luego pending', async () => {
  const file = tmpFile();
  const j = new QueueJournal(file);
  j.snapshot('work-assistant', [item('pendiente-1'), item('pendiente-2')], [item('en-curso')]);
  await j.flush();

  const j2 = new QueueJournal(file); // "reinicio"
  const restored = await j2.restore();
  const items = restored.get('work-assistant');
  assert.equal(items.length, 3);
  assert.deepEqual(items.map(i => i.text), ['en-curso', 'pendiente-1', 'pendiente-2']);
});

test('cola vacía: el agente desaparece del journal', async () => {
  const file = tmpFile();
  const j = new QueueJournal(file);
  j.snapshot('work-assistant', [item('x')], []);
  j.snapshot('work-assistant', [], []);
  await j.flush();
  const restored = await new QueueJournal(file).restore();
  assert.equal(restored.size, 0);
});

test('journal ausente: restore devuelve vacío sin error', async () => {
  const restored = await new QueueJournal(tmpFile()).restore();
  assert.equal(restored.size, 0);
});

test('journal corrupto: se aparta como .corrupt y restore devuelve vacío', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'no-json{');
  const restored = await new QueueJournal(file).restore();
  assert.equal(restored.size, 0);
  assert.ok(fs.existsSync(`${file}.corrupt`));
});

test('entradas malformadas se filtran', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    'work-assistant': { pending: [{ text: 'ok' }, { noText: true }, null], inflight: 'no-array' },
    'fantasma': null,
  }));
  const restored = await new QueueJournal(file).restore();
  assert.deepEqual(restored.get('work-assistant').map(i => i.text), ['ok']);
});
