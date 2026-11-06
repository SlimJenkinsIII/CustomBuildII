import test from 'node:test';
import assert from 'node:assert/strict';
import { newSyncKeys, pairingCode, parsePairingCode, validKeys, cleanKeys, createSyncClient, planSync, SyncError, SYNC_ORIGIN } from '../app/src/sync.js';
import { handle } from '../sync/worker.js';
import { fakeD1 } from './helpers-d1.js';
import { createVault, seal, unlock, openWith } from '../app/src/vault.js';

const serverFetch = env => (url, init = {}) => handle(new Request(url, init), env);
const mkEnv = () => ({ DB: fakeD1(), ALLOWED_ORIGIN: 'https://app.example' });
const ITER = 2000;

test('keys have the shape the server expects, and are different every time', () => {
  const a = newSyncKeys(), b = newSyncKeys();
  assert.ok(validKeys(a));
  assert.notDeepEqual(a, b);
  assert.match(a.id, /^[a-z0-9]{26}$/);
  assert.match(a.token, /^[a-z0-9]{32}$/);
  assert.equal(cleanKeys({ id: 'x', token: 'y' }), null);
});

test('a pairing code round-trips, however it is pasted', () => {
  const keys = newSyncKeys();
  const code = pairingCode(keys);
  assert.match(code, /^([0-9A-Z]{5}-){11}[0-9A-Z]{5}$/);
  assert.deepEqual(parsePairingCode(code), keys);
  assert.deepEqual(parsePairingCode(code.toLowerCase().replace(/-/g, ' ')), keys);
  assert.deepEqual(parsePairingCode('  ' + code + '\n'), keys);
});

test('a mistyped or short pairing code is refused with a plain reason', () => {
  const code = pairingCode(newSyncKeys());
  assert.throws(() => parsePairingCode(code.slice(0, 20)), /right length/);
  const flipped = code.replace(/[0-9A-Z]/, c => (c === '2' ? '3' : '2'));
  assert.throws(() => parsePairingCode(flipped), /typo/);
  assert.throws(() => parsePairingCode(''), /right length/);
});

test('the plan: what a device does for each situation', () => {
  assert.equal(planSync({ baseRev: 0, dirty: true, remote: null }), 'push');
  assert.equal(planSync({ baseRev: 4, dirty: false, remote: { rev: 4 } }), 'idle');
  assert.equal(planSync({ baseRev: 4, dirty: true, remote: { rev: 4 } }), 'push');
  assert.equal(planSync({ baseRev: 4, dirty: false, remote: { rev: 6 } }), 'pull');
  assert.equal(planSync({ baseRev: 4, dirty: true, remote: { rev: 6 } }), 'conflict');
  assert.equal(planSync({ baseRev: 6, dirty: false, remote: { rev: 4 } }), 'rollback');
  assert.equal(planSync({ baseRev: 6, dirty: true, remote: null }), 'push');                   // server copy deleted: put it back
});

test('end to end: one device saves, another pairs with the code and opens the same data', async () => {
  const env = mkEnv();
  const client = createSyncClient({ origin: 'https://sync.example', fetchImpl: serverFetch(env) });
  const keys = newSyncKeys();
  // device A
  const vaultA = await createVault('correct horse battery', ITER);
  const envelope = await seal(vaultA, { raw: [{ id: '1', cents: -500 }], sync: keys });
  const first = await client.push(keys.id, keys.token, 0, envelope);
  assert.deepEqual(first, { ok: true, rev: 1 });
  // device B knows only the pairing code and the passphrase
  const got = parsePairingCode(pairingCode(keys));
  const pulled = await client.pull(got.id, got.token);
  const { vault: vaultB, data } = await unlock(pulled.envelope, 'correct horse battery');
  assert.deepEqual(data.raw, [{ id: '1', cents: -500 }]);
  // device B saves a change with the key it just derived, and device A reads it without asking for the passphrase again
  const second = await client.push(keys.id, keys.token, pulled.rev, await seal(vaultB, { ...data, raw: [...data.raw, { id: '2', cents: -700 }] }));
  assert.deepEqual(second, { ok: true, rev: 2 });
  const back = await client.pull(keys.id, keys.token);
  assert.equal((await openWith(vaultA, back.envelope)).raw.length, 2);
});

test('what the server holds cannot be read without the passphrase, and the wrong passphrase fails', async () => {
  const env = mkEnv();
  const client = createSyncClient({ origin: 'https://sync.example', fetchImpl: serverFetch(env) });
  const keys = newSyncKeys();
  const vault = await createVault('right passphrase', ITER);
  await client.push(keys.id, keys.token, 0, await seal(vault, { raw: [{ description: 'WHOLE FOODS 4,200.00' }] }));
  const stored = JSON.stringify(env.DB.raw.prepare('SELECT * FROM chunks').all());
  assert.ok(!/WHOLE FOODS|4,200/.test(stored));
  const pulled = await client.pull(keys.id, keys.token);
  await assert.rejects(unlock(pulled.envelope, 'wrong passphrase'), /Wrong passphrase/);
});

test('two devices saving from the same revision: the second is told, and nothing is lost', async () => {
  const env = mkEnv();
  const client = createSyncClient({ origin: 'https://sync.example', fetchImpl: serverFetch(env) });
  const keys = newSyncKeys();
  const vault = await createVault('pass', ITER);
  await client.push(keys.id, keys.token, 0, await seal(vault, { n: 1 }));
  assert.deepEqual(await client.push(keys.id, keys.token, 1, await seal(vault, { n: 2 })), { ok: true, rev: 2 });
  assert.deepEqual(await client.push(keys.id, keys.token, 1, await seal(vault, { n: 3 })), { ok: false, rev: 2 });
  assert.equal((await openWith(vault, (await client.pull(keys.id, keys.token)).envelope)).n, 2);
});

test('a vault made with a different passphrase set-up needs the passphrase, not the open key', async () => {
  const a = await createVault('one', ITER), b = await createVault('one', ITER);          // same passphrase, different salt
  await assert.rejects(openWith(a, await seal(b, { x: 1 })), e => e.needsPassphrase === true);
});

test('errors are described in plain words: offline, refused, and a missing vault', async () => {
  const offline = createSyncClient({ origin: 'https://sync.example', fetchImpl: async () => { throw new TypeError('network'); } });
  await assert.rejects(offline.pull('a'.repeat(26), 'b'.repeat(32)), e => e instanceof SyncError && e.kind === 'offline');
  const env = mkEnv();
  const client = createSyncClient({ origin: 'https://sync.example', fetchImpl: serverFetch(env) });
  const keys = newSyncKeys();
  assert.equal(await client.pull(keys.id, keys.token), null);
  await client.push(keys.id, keys.token, 0, await seal(await createVault('p', ITER), { a: 1 }));
  await assert.rejects(client.pull(keys.id, 'z'.repeat(32)), e => e.kind === 'denied');
});

test('the client sends no cookies or referrer, and never caches', async () => {
  let seen;
  const client = createSyncClient({ origin: 'https://sync.example', fetchImpl: async (url, init) => { seen = { url, init }; return new Response('{"exists":false}', { status: 200 }); } });
  await client.pull('a'.repeat(26), 'b'.repeat(32));
  assert.equal(seen.init.credentials, 'omit');
  assert.equal(seen.init.cache, 'no-store');
  assert.equal(seen.init.referrerPolicy, 'no-referrer');
  assert.ok(seen.url.startsWith('https://sync.example/v1/vault/'));
});

test('the sync address is one fixed place', () => { assert.match(SYNC_ORIGIN, /^https:\/\/[a-z0-9.-]+$/); });
