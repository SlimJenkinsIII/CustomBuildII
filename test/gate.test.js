import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAccess, checkCode, fingerprint, deriveHex } from '../app/src/gate.js';

const CODE = 'blue fox 7 jumps high';
const stamp = (code, html = '<html><head><meta name="app-access" content=""></head></html>') => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  const file = join(dir, 'index.html');
  writeFileSync(file, html);
  const out = execFileSync('node', ['scripts/stamp-access.mjs', file], { env: { ...process.env, ACCESS_CODE: code }, encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname });
  return { out, html: readFileSync(file, 'utf8'), dir };
};
const specFrom = html => parseAccess(/name="app-access" content="([^"]*)"/.exec(html)[1]);

test('a site stamped with a code opens for that code, and only that code', async () => {
  const { html } = stamp(CODE);
  const spec = specFrom(html);
  assert.ok(spec);
  assert.equal(await checkCode(CODE, spec), true);
  assert.equal(await checkCode('  ' + CODE + '  ', spec), true);        // stray spaces from pasting don't matter
  assert.equal(await checkCode('blue fox 7 jumps higher', spec), false);
  assert.equal(await checkCode('', spec), false);
});

test('the code itself is nowhere in the stamped page, only a salted slow hash of it', () => {
  const { html } = stamp(CODE);
  assert.ok(!html.includes(CODE));
  assert.match(html, /content="v1\.600000\.[A-Za-z0-9_-]{16,}\.[0-9a-f]{64}"/);
});

test('stamping twice with the same code gives the same result, so devices stay let in after a redeploy; a new code changes it', () => {
  const a = specFrom(stamp(CODE).html), b = specFrom(stamp(CODE).html), c = specFrom(stamp('a different code!').html);
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint(c));
});

test('without a code nothing is stamped, and a short code is refused', () => {
  const { out, html } = stamp('');
  assert.match(out, /without a front door/);
  assert.match(html, /name="app-access" content=""/);
  assert.equal(parseAccess(''), null);
  assert.throws(() => stamp('short'), /at least 8/);
});

test('garbage access settings are ignored rather than trusted', () => {
  for (const bad of ['v1.1.x.y', 'v2.600000.AAAAAAAAAAAAAAAAAAAAAA.' + 'a'.repeat(64), 'v1.10.AAAAAAAAAAAAAAAAAAAAAA.' + 'a'.repeat(64), 'nonsense']) assert.equal(parseAccess(bad), null);
});

test('the hash is a real slow hash: it matches the browser-side derivation', async () => {
  const { html } = stamp(CODE);
  const spec = specFrom(html);
  assert.equal(await deriveHex(CODE, spec.salt, spec.iter), spec.hash);
});

test('the published page is hidden until the door is opened, with no app wording visible in the gate', () => {
  const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(html, /html\[data-gated\] body > \*:not\(#gate\)/);
  const gate = /<section id="gate"[\s\S]*?<\/section>/.exec(html)[0];
  assert.doesNotMatch(gate, /budget|money|bank|chase|amex/i);
});
