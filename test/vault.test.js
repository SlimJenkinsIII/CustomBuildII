import test from 'node:test';
import assert from 'node:assert/strict';
import { createVault, seal, unlock, looksLikeEnvelope } from '../app/src/vault.js';
import { memoryStorage } from '../app/src/storage.js';

const FAST = 1000; // few iterations so tests run quickly; the app uses 600,000
const data = { raw: [{ id: 'a', description: 'WHOLEFDS MKT 10234 AUSTIN TX', cents: -8412 }], overrides: { a: 'free_gifts' }, trips: [] };

test('round trip: what goes in comes back exactly', async () => {
  const vault = await createVault('correct horse battery', FAST);
  const back = await unlock(await seal(vault, data), 'correct horse battery');
  assert.deepEqual(back.data, data);
});

test('the stored envelope contains no readable data', async () => {
  const vault = await createVault('correct horse battery', FAST);
  const text = JSON.stringify(await seal(vault, data));
  for (const secret of ['WHOLEFDS', 'AUSTIN', '8412', 'free_gifts']) assert.ok(!text.includes(secret), secret);
});

test('a wrong passphrase is rejected', async () => {
  const vault = await createVault('correct horse battery', FAST);
  const env = await seal(vault, data);
  await assert.rejects(() => unlock(env, 'wrong passphrase'), /Wrong passphrase/);
  await assert.rejects(() => unlock(env, ''), /Wrong passphrase/);
});

test('tampering with the stored data is detected', async () => {
  const vault = await createVault('correct horse battery', FAST);
  const env = await seal(vault, data);
  const bytes = Uint8Array.from(atob(env.data), c => c.charCodeAt(0));
  bytes[5] ^= 1;                                                     // flip one bit
  const damaged = { ...env, data: btoa(String.fromCharCode(...bytes)) };
  await assert.rejects(() => unlock(damaged, 'correct horse battery'), /damaged/);
});

test('every save uses a fresh IV, and saving again with the unlocked key still works', async () => {
  const vault = await createVault('correct horse battery', FAST);
  const a = await seal(vault, data), b = await seal(vault, data);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.data, b.data);
  const reopened = await unlock(a, 'correct horse battery');
  const c = await seal(reopened.vault, { ...data, trips: [{ slot: 1 }] });   // the unlocked vault can save again
  assert.deepEqual((await unlock(c, 'correct horse battery')).data.trips, [{ slot: 1 }]);
});

test('different vaults get different salts', async () => {
  const a = await seal(await createVault('same passphrase', FAST), data);
  const b = await seal(await createVault('same passphrase', FAST), data);
  assert.notEqual(a.salt, b.salt);
});

test('files that are not backups, or have unsafe settings, are refused', async () => {
  const vault = await createVault('correct horse battery', FAST);
  const env = await seal(vault, data);
  assert.equal(looksLikeEnvelope(env), true);
  assert.equal(looksLikeEnvelope({}), false);
  assert.equal(looksLikeEnvelope(null), false);
  assert.equal(looksLikeEnvelope({ ...env, iter: 1 }), false);          // too weak
  assert.equal(looksLikeEnvelope({ ...env, iter: 10 ** 9 }), false);    // would freeze the app
  await assert.rejects(() => unlock({ hello: 'world' }, 'x'), /not a My Budget backup/);
});

test('large data survives (a few years of transactions)', async () => {
  const big = { raw: Array.from({ length: 20000 }, (_, i) => ({ id: `id${i}`, description: `MERCHANT ${i}`, cents: -i })) };
  const vault = await createVault('correct horse battery', FAST);
  const back = await unlock(await seal(vault, big), 'correct horse battery');
  assert.equal(back.data.raw.length, 20000);
  assert.equal(back.data.raw[19999].id, 'id19999');
});

test('memory storage keeps, returns and clears an envelope', async () => {
  const store = memoryStorage();
  assert.equal(await store.load(), null);
  await store.save({ x: 1 });
  assert.deepEqual(await store.load(), { x: 1 });
  await store.clear();
  assert.equal(await store.load(), null);
});
