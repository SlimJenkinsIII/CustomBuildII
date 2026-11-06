import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../sync/worker.js';
import { fakeD1 } from './helpers-d1.js';

const ID = 'a1b2c3d4e5f6g7h8i9j0k1l2m3';
const TOKEN = 'tok1234567890abcdefghijklmnopqrstuv';
const OTHER = 'zzz1234567890abcdefghijklmnopqrstuv';
const ENV = '{"app":"my-budget","v":1,"data":"' + 'x'.repeat(40) + '"}';
const mk = () => ({ DB: fakeD1(), ALLOWED_ORIGIN: 'https://app.example' });
const call = (env, method, { id = ID, token = TOKEN, body, ifMatch } = {}) => handle(new Request(`https://sync.example/v1/vault/${id}`, {
  method, headers: { ...(token && { authorization: `Bearer ${token}` }), ...(ifMatch !== undefined && { 'if-match': String(ifMatch) }) }, body,
}), env);

test('a vault is created, read back exactly, and revisions count up', async () => {
  const env = mk();
  assert.deepEqual(await (await call(env, 'GET')).json(), { exists: false });
  const put1 = await call(env, 'PUT', { body: ENV, ifMatch: 0 });
  assert.equal(put1.status, 200);
  assert.equal((await put1.json()).rev, 1);
  const got = await (await call(env, 'GET')).json();
  assert.equal(got.rev, 1);
  assert.equal(got.envelope, ENV);                          // byte for byte: the server never looks inside
  const next = ENV.replace('x', 'y');
  assert.equal((await (await call(env, 'PUT', { body: next, ifMatch: 1 })).json()).rev, 2);
  assert.equal((await (await call(env, 'GET')).json()).envelope, next);
});

test('a save must say which revision it is based on, and a stale one is refused', async () => {
  const env = mk();
  await call(env, 'PUT', { body: ENV, ifMatch: 0 });
  await call(env, 'PUT', { body: ENV, ifMatch: 1 });          // rev 2
  const stale = await call(env, 'PUT', { body: ENV, ifMatch: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).rev, 2);                  // tells the device what is current
  assert.equal((await call(env, 'PUT', { body: ENV })).status, 428);
  assert.equal((await call(env, 'PUT', { body: ENV, ifMatch: 0 })).status, 409);   // can't "create" over an existing vault
});

test('without the right token nothing can be read, written or deleted', async () => {
  const env = mk();
  await call(env, 'PUT', { body: ENV, ifMatch: 0 });
  for (const method of ['GET', 'DELETE']) assert.equal((await call(env, method, { token: OTHER })).status, 401);
  assert.equal((await call(env, 'PUT', { token: OTHER, body: ENV, ifMatch: 1 })).status, 401);
  assert.equal((await call(env, 'GET', { token: null })).status, 401);
  assert.equal((await call(env, 'GET', { token: 'short' })).status, 401);
  assert.equal((await (await call(env, 'GET')).json()).rev, 1);              // still intact
});

test('the server stores only a hash of the token, and nothing it can read of your data', async () => {
  const env = mk();
  await call(env, 'PUT', { body: ENV, ifMatch: 0 });
  const dump = JSON.stringify([env.DB.raw.prepare('SELECT * FROM vaults').all(), env.DB.raw.prepare('SELECT * FROM chunks').all()]);
  assert.ok(!dump.includes(TOKEN));
  assert.match(env.DB.raw.prepare('SELECT token_hash FROM vaults').get().token_hash, /^[0-9a-f]{64}$/);
});

test('big vaults are stored in pieces and come back whole; old revisions are pruned', async () => {
  const env = mk();
  const big = '{"data":"' + 'q'.repeat(2_300_000) + '"}';
  await call(env, 'PUT', { body: big, ifMatch: 0 });
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM chunks').get().n, 3);
  assert.equal((await (await call(env, 'GET')).json()).envelope, big);
  for (let r = 1; r <= 4; r++) await call(env, 'PUT', { body: ENV, ifMatch: r });
  const revs = env.DB.raw.prepare('SELECT DISTINCT rev FROM chunks ORDER BY rev').all().map(x => x.rev);
  assert.deepEqual(revs, [3, 4, 5]);                          // the last three are kept
});

test('delete removes the vault entirely', async () => {
  const env = mk();
  await call(env, 'PUT', { body: ENV, ifMatch: 0 });
  assert.equal((await call(env, 'DELETE')).status, 200);
  assert.deepEqual(await (await call(env, 'GET')).json(), { exists: false });
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM chunks').get().n, 0);
});

test('junk is refused: oversize bodies, non-envelopes, bad ids and other paths', async () => {
  const env = mk();
  assert.equal((await call(env, 'PUT', { body: 'hello', ifMatch: 0 })).status, 400);
  assert.equal((await call(env, 'PUT', { body: '{"a":"' + 'x'.repeat(6_500_000) + '"}', ifMatch: 0 })).status, 413);
  assert.equal((await call(env, 'GET', { id: 'SHORT' })).status, 404);
  assert.equal((await handle(new Request('https://sync.example/anything'), env)).status, 404);
  assert.equal((await call(env, 'PATCH', { body: ENV })).status, 405);
});

test('answers only to the app\'s own address in the browser, and never lets a response be cached', async () => {
  const env = mk();
  const res = await call(env, 'GET');
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const pre = await handle(new Request('https://sync.example/v1/vault/' + ID, { method: 'OPTIONS' }), env);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /if-match/);
});

test('two saves at the same moment: one wins, the other is told to look again', async () => {
  const env = mk();
  await call(env, 'PUT', { body: ENV, ifMatch: 0 });
  const [a, b] = await Promise.all([call(env, 'PUT', { body: ENV.replace('x', 'a'), ifMatch: 1 }), call(env, 'PUT', { body: ENV.replace('x', 'b'), ifMatch: 1 })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((await (await call(env, 'GET')).json()).rev, 2);
});
