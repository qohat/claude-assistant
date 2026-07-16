// Tests del router con dependencias inyectadas (clasificador y estado sticky).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AI_HOME_CONSOLE = '1';
process.env.AI_HOME_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aihome-router-'));
fs.mkdirSync(path.join(process.env.AI_HOME_DATA, 'state', 'logs'), { recursive: true });

const { route } = await import('../dist/router.js');

function fakeState(activeAgent = null) {
  const s = { activeAgent };
  return {
    getActiveAgent: () => s.activeAgent,
    setActiveAgent: id => { s.activeAgent = id; },
  };
}
const noClassify = async () => { throw new Error('el clasificador no debería llamarse'); };

test('meta-comandos', async () => {
  const r = await route('/status', { state: fakeState(), classify: noClassify });
  assert.deepEqual(r, { kind: 'meta', cmd: 'status', args: '' });
});

test('comando de agente con texto va directo y fija el sticky', async () => {
  const state = fakeState();
  const r = await route('/work revisa el PR 42', { state, classify: noClassify });
  assert.equal(r.kind, 'agent');
  assert.equal(r.agent.id, 'work-assistant');
  assert.equal(r.text, 'revisa el PR 42');
  assert.equal(state.getActiveAgent(), 'work-assistant');
});

test('comando de agente sin texto = switch', async () => {
  const r = await route('/food', { state: fakeState(), classify: noClassify });
  assert.deepEqual(r, { kind: 'meta', cmd: 'switched', args: 'nutrition-assistant' });
});

test('keywords rutean sin clasificador', async () => {
  const r = await route('clona el repo de answering-it', { state: fakeState(), classify: noClassify });
  assert.equal(r.kind, 'agent');
  assert.equal(r.agent.id, 'work-assistant');
});

test('sin keywords: cae al clasificador', async () => {
  let asked = null;
  const classify = async prompt => { asked = prompt; return 'education-assistant'; };
  const r = await route('quiero repasar lo de ayer', { state: fakeState(), classify });
  assert.ok(asked, 'debió consultar al clasificador');
  assert.equal(r.agent.id, 'education-assistant');
});

test('clasificador sin respuesta: usa el sticky', async () => {
  const r = await route('y entonces qué opinas', { state: fakeState('financial-assistant'), classify: async () => 'ninguno' });
  assert.equal(r.kind, 'agent');
  assert.equal(r.agent.id, 'financial-assistant');
});

test('sin clasificador ni sticky: pregunta', async () => {
  const r = await route('hola', { state: fakeState(), classify: async () => null });
  assert.deepEqual(r, { kind: 'ask' });
});

test('override de modelo en el mensaje', async () => {
  const r = await route('/work usa opus y refactoriza el módulo', { state: fakeState(), classify: noClassify });
  assert.equal(r.modelOverride, 'opus');
});

test('dos mensajes seguidos se procesan en orden (ruteo determinista)', async () => {
  // el clasificador del primero tarda; el segundo tiene keyword y no clasifica.
  const state = fakeState();
  const slowClassify = () => new Promise(res => setTimeout(() => res('education-assistant'), 50));
  const r1p = route('mensaje ambiguo sin pistas', { state, classify: slowClassify });
  const r2p = r1p.then(() => route('registra mi entrenamiento de hoy', { state, classify: noClassify }));
  const [r1, r2] = await Promise.all([r1p, r2p]);
  assert.equal(r1.agent.id, 'education-assistant');
  assert.equal(r2.agent.id, 'nutrition-assistant');
  assert.equal(state.getActiveAgent(), 'nutrition-assistant', 'el sticky queda en el último procesado');
});
