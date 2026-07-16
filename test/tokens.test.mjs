// Tests de TokenPool (reloj inyectable) y de los regex de clasificación de errores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AI_HOME_CONSOLE = '1';
process.env.AI_HOME_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aihome-tokens-'));
fs.mkdirSync(path.join(process.env.AI_HOME_DATA, 'state', 'logs'), { recursive: true });

const { TokenPool, RATE_LIMIT_RE, LIMIT_TEXT_RE, TRANSIENT_RE } = await import('../dist/tokens.js');

test('dedupe por valor y orden estable', () => {
  const pool = new TokenPool([['a', 't1'], ['b', 't1'], ['c', 't2']]);
  assert.deepEqual(pool.usable().map(t => t.name), ['a', 'c']);
});

test('markExhausted enfría y usable lo excluye hasta que pasa el cooldown', () => {
  let now = 1_000_000_000_000;
  const pool = new TokenPool([['a', 't1'], ['b', 't2']], () => now);
  pool.markExhausted('a', 600);
  assert.deepEqual(pool.usable().map(t => t.name), ['b']);
  assert.equal(pool.secondsUntilFree(), 0); // b sigue libre
  pool.markExhausted('b', 300);
  assert.deepEqual(pool.usable().map(t => t.name), ['a', 'b'], 'todos agotados: los devuelve igual');
  assert.equal(pool.secondsUntilFree(), 300);
  now += 301_000; // pasan 301s
  assert.deepEqual(pool.usable().map(t => t.name), ['b']);
});

test('cooldownSecsFromText: duraciones y hora de reset', () => {
  let now = Date.UTC(2026, 0, 1, 0, 0, 0); // medianoche UTC
  const pool = new TokenPool([['a', 't1']], () => now);
  assert.equal(pool.cooldownSecsFromText('rate limited, resets in 2 hours'), 7200);
  assert.equal(pool.cooldownSecsFromText('try again, resets in 30 minutes'), 1800);
  // "resets 2:10am (UTC)" → 2h10m desde medianoche
  assert.equal(pool.cooldownSecsFromText("You've hit your session limit · resets 2:10am (UTC)"), 2 * 3600 + 10 * 60);
  assert.equal(pool.cooldownSecsFromText('sin pistas de tiempo'), null);
});

test('TRANSIENT_RE: reintenta red/5xx, no reintenta rate-limit ni errores de lógica', () => {
  for (const s of ['fetch failed', 'ECONNRESET', 'socket hang up', '502 Bad Gateway',
    'Request timed out', 'API overloaded (529)', 'Internal server error']) {
    assert.ok(TRANSIENT_RE.test(s), `debería ser transitorio: ${s}`);
  }
  for (const s of ['permission denied', 'file not found', 'SyntaxError: unexpected token']) {
    assert.ok(!TRANSIENT_RE.test(s), `NO debería ser transitorio: ${s}`);
  }
});

test('RATE_LIMIT_RE y LIMIT_TEXT_RE detectan los mensajes vistos en producción', () => {
  assert.ok(RATE_LIMIT_RE.test('429 too many requests'));
  assert.ok(RATE_LIMIT_RE.test('usage limit reached'));
  assert.ok(LIMIT_TEXT_RE.test("You've hit your session limit · resets 2:10am (UTC)"));
  assert.ok(!LIMIT_TEXT_RE.test('todo bien, tarea completada'));
});
