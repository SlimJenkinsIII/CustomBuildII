// Two devices, one sync server, in real browsers with the app's real security rules on.
// The sync server is the real Worker code on a real SQLite database; the browser's requests to the sync address are
// answered by it in-process (the sandbox has no internet).  Run:  NODE_PATH=$(npm root -g) node test/e2e-sync.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const SITE = process.env.SITE_DIR ? path.resolve(ROOT, process.env.SITE_DIR) : path.join(ROOT, 'app');
const PREFIX = process.env.E2E_PREFIX || '/';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.csv': 'text/csv' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (!url.startsWith(PREFIX)) { res.writeHead(404); return res.end(); }
  const file = path.join(SITE, url.slice(PREFIX.length) || 'index.html');
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
const SAMPLES = ['FAKE-jan-feb-chase-checking.csv', 'FAKE-jan-feb-chase-card.csv', 'FAKE-jan-feb-amex.csv'].map(f => path.join(ROOT, 'samples', f));
const PASS = 'correct horse battery';
let failures = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) failures++; };

server.listen(0, async () => {
  const { handle } = await import('../sync/worker.js');
  const { fakeD1 } = await import('./helpers-d1.js');
  const env = { DB: fakeD1(), ALLOWED_ORIGIN: `http://localhost:${server.address().port}` };
  const seen = [];                                           // every address the browsers tried to reach, other than the app itself
  const browser = await chromium.launch();
  const problems = [];
  const device = async name => {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 1000 } });
    await ctx.route('https://sync.millhaus.app/**', async route => {
      const r = route.request();
      const res = await handle(new Request(r.url(), { method: r.method(), headers: r.headers(), body: ['GET', 'HEAD', 'OPTIONS'].includes(r.method()) ? undefined : r.postData() }), env);
      seen.push(`${name} ${r.method()}`);
      await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => problems.push(`${name} pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(`${name}: ${m.text()}`); });
    page.on('request', r => { const u = new URL(r.url()); if (!u.href.startsWith(`http://localhost:${server.address().port}`) && u.origin !== 'https://sync.millhaus.app' && !r.url().startsWith('data:')) problems.push(`${name} reached ${u.origin}`); });
    await page.goto(`http://localhost:${server.address().port}${PREFIX}index.html`);
    return { ctx, page };
  };
  const gear = async (page, screen) => { await page.click('#gear'); if (screen) await page.locator('#settings-body .menu-row', { hasText: screen }).click(); };
  const close = page => page.click('#settings-close');
  const count = async page => { await page.click('#tab-fs'); await page.selectOption('#fs-page', 'gl'); return Number((await page.textContent('#gl-count')).match(/(\d+)/)[1]); };

  // ----- device A: has data, sets a passphrase, turns sync on -----
  const A = await device('A');
  await A.page.setInputFiles('#file', SAMPLES);
  await A.page.waitForSelector('#panel-budget:not([hidden])');
  await A.page.click('#banner-btn');
  await A.page.fill('#sec-pass', PASS); await A.page.fill('#sec-pass2', PASS); await A.page.click('text=Save on this device');
  await A.page.waitForFunction(() => document.getElementById('savechip').textContent === 'Saved on this device', null, { timeout: 15000 });
  await close(A.page);
  const nA = await count(A.page);
  await gear(A.page, 'Sync');
  check('Settings has a Sync screen that starts off', await A.page.locator('#sync-on').count() === 1);
  await A.page.click('#sync-on');
  await A.page.waitForSelector('#pair-code');
  check('turning sync on says it is on', /Sync is on/.test(await A.page.textContent('#settings-body')));
  check('the pairing code is hidden until you ask', !/^[0-9A-Z]{5}-/.test(await A.page.textContent('#pair-code')));
  await A.page.click('#pair-show');
  const code = (await A.page.textContent('#pair-code')).trim();
  check('the pairing code is 60 characters in groups of five', /^([0-9A-Z]{5}-){11}[0-9A-Z]{5}$/.test(code));
  check('the server holds the data, and only encrypted', env.DB.raw.prepare('SELECT COUNT(*) AS n FROM vaults').get().n === 1 && !/WHOLEFDS|MAGNOLIA|HARBOR/.test(JSON.stringify(env.DB.raw.prepare('SELECT * FROM chunks').all())));
  check('the chip says synced', /synced/.test(await A.page.textContent('#savechip')));
  await close(A.page);

  // ----- device B: nothing on it; pairs with the code and the passphrase -----
  const B = await device('B');
  await gear(B.page, 'Sync');
  await B.page.fill('#join-code', 'not a code'); await B.page.fill('#join-pass', PASS); await B.page.click('#join-go');
  await B.page.waitForFunction(() => /right length/.test(document.querySelector('#settings-body .msg').textContent));
  check('a bad code is refused with a plain reason', true);
  await B.page.fill('#join-code', code.toLowerCase().replace(/-/g, ' ')); await B.page.fill('#join-pass', 'wrong passphrase here'); await B.page.click('#join-go');
  await B.page.waitForFunction(() => /Wrong passphrase/.test(document.querySelector('#settings-body .msg').textContent), null, { timeout: 20000 });
  check('a wrong passphrase is refused and nothing is loaded', (await B.page.locator('#panel-budget').isHidden()));
  await B.page.fill('#join-code', code); await B.page.fill('#join-pass', PASS); await B.page.click('#join-go');
  await B.page.waitForFunction(() => /Paired/.test(document.querySelector('#settings-body .msg')?.textContent ?? ''), null, { timeout: 20000 });
  await close(B.page);
  check('device B now has the same data as A', (await count(B.page)) === nA, `${nA}`);

  // ----- a change on A reaches B -----
  await gear(A.page, 'TB coding');
  await A.page.fill('#name-free_coffee', 'Cafes'); await A.page.press('#name-free_coffee', 'Tab');
  await close(A.page);
  await A.page.waitForFunction(() => /synced/.test(document.getElementById('savechip').textContent) && !/syncing/.test(document.getElementById('savechip').textContent), null, { timeout: 15000 });
  await A.page.waitForTimeout(2500);
  await gear(B.page, 'Sync'); await B.page.click('#sync-now');
  await B.page.waitForFunction(() => /In step/.test(document.getElementById('sync-status')?.textContent ?? ''), null, { timeout: 15000 });
  await close(B.page);
  await gear(B.page, 'TB coding');
  check('the rename made on A shows on B', (await B.page.inputValue('#name-free_coffee')) === 'Cafes');
  await close(B.page);

  // ----- both change before syncing: the second to sync is asked, and the choice sticks -----
  await gear(A.page, 'TB coding'); await A.page.fill('#name-free_coffee', 'From A'); await A.page.press('#name-free_coffee', 'Tab'); await close(A.page);
  await A.page.waitForTimeout(3500);
  await gear(B.page, 'TB coding'); await B.page.fill('#name-free_coffee', 'From B'); await B.page.press('#name-free_coffee', 'Tab'); await close(B.page);
  await B.page.waitForSelector('#syncbanner:not([hidden])', { timeout: 20000 });
  check('when both devices changed, B is asked which to keep', /Which copy/.test(await B.page.textContent('#syncbanner')));
  await B.page.click('#keep-this');
  await B.page.waitForSelector('#syncbanner', { state: 'hidden', timeout: 20000 });
  await gear(A.page, 'Sync'); await A.page.click('#sync-now');
  await A.page.waitForFunction(() => /In step/.test(document.getElementById('sync-status')?.textContent ?? ''), null, { timeout: 15000 });
  await close(A.page);
  await gear(A.page, 'TB coding');
  check('keeping B\'s version makes A match it', (await A.page.inputValue('#name-free_coffee')) === 'From B');
  await close(A.page);

  // ----- turning sync off on a device leaves the others syncing; deleting the copy removes it -----
  await gear(B.page, 'Sync');
  await B.page.locator('button', { hasText: 'Delete the synced copy' }).click(); await B.page.locator('button', { hasText: 'Tap again to delete it' }).click();
  await B.page.waitForSelector('#sync-on');
  check('deleting the synced copy removes it from the server', env.DB.raw.prepare('SELECT COUNT(*) AS n FROM vaults').get().n === 0);
  await close(B.page);
  check('and this device keeps its own data', (await count(B.page)) === nA);

  check('the browsers contacted nothing but the app and the sync address', !problems.some(p => / reached /.test(p)), problems.filter(p => / reached /.test(p)).join(' | '));
  check('no errors or security-policy violations', problems.length === 0, JSON.stringify(problems));
  await browser.close(); server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
});
