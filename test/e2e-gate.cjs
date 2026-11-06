// The front door, in a real browser: a stranger sees only a password box; the right code opens the app.
// Builds the site WITH an access code, serves it, then rebuilds it without.   NODE_PATH=$(npm root -g) node test/e2e-gate.cjs
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const CODE = 'blue fox 7 jumps high';
execSync('bash scripts/build-site.sh', { cwd: ROOT, env: { ...process.env, ACCESS_CODE: CODE }, stdio: 'ignore' });
const SITE = path.join(ROOT, '_site');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const file = path.join(SITE, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
let failures = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) failures++; };

server.listen(0, async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(m.text()); });
  const URL = `http://localhost:${server.address().port}/`;
  await page.goto(URL);
  await page.waitForSelector('#gate-code');

  const visible = await page.evaluate(() => document.body.innerText);
  check('a stranger sees only the access-code box', /Access code|Continue/i.test(visible) && !/budget|trial balance|F\/S|Summary|Chase/i.test(visible), JSON.stringify(visible.slice(0, 120)));
  check('the tab is plainly titled, not named after the app', (await page.title()) === 'Private');
  check('none of the app is on screen', (await page.locator('#app').isVisible().catch(() => false)) === false && (await page.locator('main').isVisible().catch(() => false)) === false);
  check('no data is loaded behind the door (nothing was read from storage)', (await page.locator('#savechip').isVisible().catch(() => false)) === false);

  await page.fill('#gate-code', 'wrong code entirely'); await page.click('#gate-btn');
  await page.waitForFunction(() => /isn.t right/.test(document.getElementById('gate-msg').textContent), null, { timeout: 20000 });
  check('a wrong code is refused and nothing opens', (await page.locator('#gate').isVisible()) && (await page.title()) === 'Private');

  await page.waitForFunction(() => !document.getElementById('gate-btn').disabled, null, { timeout: 10000 });
  await page.fill('#gate-code', CODE); await page.click('#gate-btn');
  await page.waitForSelector('main', { state: 'visible', timeout: 20000 });
  check('the right code opens the app', (await page.locator('main').isVisible()) && (await page.title()) === 'My Budget' && (await page.locator('#gate').isHidden()));
  check('the code is not kept anywhere on the device', !(await page.evaluate(() => JSON.stringify({ ...localStorage }))).includes('blue fox'));

  await page.reload();
  await page.waitForSelector('main', { state: 'visible', timeout: 20000 });
  check('this device stays let in after a reload', await page.locator('#gate').isHidden());

  await page.evaluate(() => localStorage.removeItem('my-budget-access'));
  await page.reload();
  await page.waitForSelector('#gate-code');
  check('clearing the device\'s memory closes the door again', await page.locator('main').isHidden());

  // someone with a stale "let in" mark from a different code is not let in
  await page.evaluate(() => localStorage.setItem('my-budget-access', 'deadbeefdeadbeef'));
  await page.reload();
  await page.waitForSelector('#gate-code');
  check('a mark left by an old or made-up code does not open it', await page.locator('main').isHidden());

  check('no errors or security-policy violations', problems.length === 0, JSON.stringify(problems));
  await browser.close(); server.close();
  execSync('bash scripts/build-site.sh', { cwd: ROOT, env: { ...process.env, ACCESS_CODE: '' }, stdio: 'ignore' });   // leave _site as a normal build
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
});
