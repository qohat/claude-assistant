// Tests de StateStore: escrituras serializadas, archivo corrupto apartado,
// persistencia entre instancias.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AI_HOME_CONSOLE = '1';
process.env.AI_HOME_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aihome-state-'));
fs.mkdirSync(path.join(process.env.AI_HOME_DATA, 'state', 'logs'), { recursive: true });

const { StateStore } = await import('../dist/state.js');

const tmpFile = () => path.join(process.env.AI_HOME_DATA, 'state', `s-${Math.random().toString(36).slice(2)}.json`);

test('sesiones: set/get/clear y agente activo', async () => {
  const store = new StateStore(tmpFile());
  assert.equal(store.getSession('work-assistant'), undefined);
  store.setSession('work-assistant', 'abc');
  store.setActiveAgent('work-assistant');
  assert.equal(store.getSession('work-assistant'), 'abc');
  assert.equal(store.getActiveAgent(), 'work-assistant');
  store.clearSession('work-assistant');
  assert.equal(store.getSession('work-assistant'), undefined);
  await store.flush();
});

test('dos agentes escribiendo "a la vez" no se pisan el session id', async () => {
  const file = tmpFile();
  const store = new StateStore(file);
  // simula el bug original: dos turnos terminan en paralelo y persisten
  store.setSession('work-assistant', 's1');
  store.setSession('financial-assistant', 's2');
  await store.flush();
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.sessions['work-assistant'].sessionId, 's1');
  assert.equal(onDisk.sessions['financial-assistant'].sessionId, 's2');
});

test('otra instancia lee lo persistido', async () => {
  const file = tmpFile();
  const a = new StateStore(file);
  a.setSession('education-assistant', 'xyz');
  await a.flush();
  const b = new StateStore(file);
  assert.equal(b.getSession('education-assistant'), 'xyz');
});

test('archivo corrupto: se aparta como .corrupt y arranca limpio', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ esto no es json');
  const store = new StateStore(file);
  assert.equal(store.getActiveAgent(), null);
  assert.ok(fs.existsSync(`${file}.corrupt`), 'debe conservar el archivo corrupto');
  // y el siguiente save NO pisa nada: escribe el estado nuevo
  store.setSession('work-assistant', 'nuevo');
  await store.flush();
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.sessions['work-assistant'].sessionId, 'nuevo');
});

test('muchas escrituras seguidas: la última gana y el archivo queda válido', async () => {
  const file = tmpFile();
  const store = new StateStore(file);
  for (let i = 0; i < 50; i++) store.setSession('work-assistant', `s${i}`);
  await store.flush();
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.sessions['work-assistant'].sessionId, 's49');
});
