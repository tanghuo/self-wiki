import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPairingLimiter } from '../../src/server/http/pairingLimiter.js';

test('pairing limits isolate peers, bound aggregate guesses, reset for a new code and expire', (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const limiter = createPairingLimiter();
  for (let i = 0; i < 10; i++) assert.equal(limiter.attempt('attacker', 'code1'), 0);
  assert.equal(limiter.attempt('attacker', 'code1'), 60);
  assert.equal(limiter.attempt('owner-phone', 'code1'), 0);
  for (let i = 0; i < 89; i++) assert.equal(limiter.attempt(`peer-${i}`, 'code1'), 0);
  assert.equal(limiter.attempt('new-peer', 'code1'), 60);
  assert.equal(limiter.attempt('attacker', 'code2'), 0);
  t.mock.method(Date, 'now', () => 62000);
  assert.equal(limiter.attempt('attacker', 'code2'), 0);
});
