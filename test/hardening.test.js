import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const html = read('app/index.html');
const head = html.slice(0, html.indexOf('<body>'));

test('the connection and framing rules are all in the page head, ahead of any script', () => {
  const csp = head.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
  for (const rule of ["default-src 'self'", "connect-src https://sync.millhaus.app", "script-src 'self'", "object-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"]) {
    assert.ok(csp.includes(rule), rule);
  }
  assert.ok(!csp.includes('unsafe-eval'));
  assert.ok(head.indexOf('Content-Security-Policy') < head.indexOf('<script'), 'the policy must come before any script');
});

test('clickjacking guard: the page starts hidden and a script from our own site reveals it', () => {
  assert.ok(head.includes('<style id="antiframe">html { display: none; }</style>'));
  assert.ok(head.includes('<script src="src/frameguard.js"></script>'));
  const scriptAt = head.indexOf('<script src="src/frameguard.js">');
  assert.ok(head.indexOf('<style id="antiframe">') < scriptAt, 'hidden first, revealed after');
  assert.ok(scriptAt < html.indexOf('<script type="module" src="src/main.js">'), 'the guard runs before the app');
  const guard = read('app/src/frameguard.js');
  assert.ok(/window\.top\s*!==\s*window\.self/.test(guard));
  assert.ok(!/fetch\(|XMLHttpRequest|import\s/.test(guard), 'a plain classic script with no network calls');
});

test('people without JavaScript still see a message, not a blank page', () => {
  assert.ok(head.includes('<noscript><style>html { display: block !important; }</style></noscript>'));
  assert.ok(html.includes('This app needs JavaScript'));
});

test('pages tell browsers not to pass on where you came from and ask search engines to skip them', () => {
  for (const f of ['app/index.html', 'app/test-files.html']) {
    const page = read(f);
    assert.ok(page.includes('<meta name="referrer" content="no-referrer">'), `${f} referrer`);
    assert.ok(page.includes('<meta name="robots" content="noindex, nofollow">'), `${f} robots`);
  }
});

test('the publish workflow only uses GitHub\'s own actions, with the smallest permissions it needs', () => {
  const wf = read('.github/workflows/pages.yml');
  const uses = [...wf.matchAll(/uses:\s*([^\s@]+)@/g)].map(m => m[1]);
  assert.ok(uses.length >= 5);
  assert.ok(uses.every(u => u.startsWith('actions/')), uses.join(', '));
  assert.match(wf, /permissions:\s*\n\s+contents: read\s*\n\s+pages: write\s*\n\s+id-token: write/);
  assert.ok(!/pull_request_target/.test(wf), 'no workflow that runs with write access on outside pull requests');
});

test('GitHub is asked to keep the workflow\'s tools up to date, by pull request', () => {
  const d = read('.github/dependabot.yml');
  assert.match(d, /package-ecosystem:\s*"github-actions"/);
  assert.match(d, /interval:\s*"weekly"/);
});

test('the update helper only fetches this site\'s own files, GET only, and stores no data', () => {
  const sw = readFileSync(new URL('../app/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /self\.location\.origin/);
  assert.match(sw, /req\.method !== 'GET'/);
  assert.doesNotMatch(sw, /https?:\/\//);
  assert.doesNotMatch(sw, /indexedDB|localStorage|postMessage|WebSocket|sendBeacon|POST/);
  assert.equal((sw.match(/fetch\(/g) ?? []).length, 1);          // the one fetch of a same-site file
});

test('the page may reach one address only (the sync server), and only the sync file makes network calls', () => {
  const html = read('app/index.html');
  const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)[1];
  const connect = csp.split(';').map(x => x.trim()).filter(x => x.startsWith('connect-src'));
  assert.equal(connect.length, 1);
  assert.deepEqual(connect[0].split(/\s+/).slice(1), ['https://sync.millhaus.app']);        // one origin, no wildcards, no 'self'
  const sync = read('app/src/sync.js');
  assert.match(sync, /SYNC_ORIGIN = 'https:\/\/sync\.millhaus\.app'/);                    // the CSP and the code agree
  for (const f of ['main.js', 'storage.js', 'vault.js', 'journal.js', 'insights.js', 'budget.js', 'rules.js', 'parsers.js', 'host.js', 'nesting.js', 'categories.js', 'dummy.js']) {
    assert.doesNotMatch(read(`app/src/${f}`), /fetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/, `${f} must not make network calls`);
  }
  assert.equal((sync.match(/fetch\(/g) ?? []).length, 1);                                    // the one call, which goes through createSyncClient
  assert.doesNotMatch(sync, /XMLHttpRequest|WebSocket|sendBeacon|EventSource/);
});

test('the sync client sends only encrypted data: it never sees a passphrase or a key', () => {
  const sync = read('app/src/sync.js');
  assert.doesNotMatch(sync, /deriveKey|importKey|crypto\.subtle|passphrase\s*[=:(]/);
});
