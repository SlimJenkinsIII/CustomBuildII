// Gas stations: small charges go to the convenience account, big ones stay as gas. In a real browser.
//   NODE_PATH=$(npm root -g) node test/e2e-fuel.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'app');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = path.join(SITE, url === '/' ? 'index.html' : url);
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
let failures = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) failures++; };

server.listen(0, async () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fuel-')), 'fuel.csv');
  fs.writeFileSync(tmp, 'Date,Description,Amount\n03/10/2026,SHELL OIL 57444 AUSTIN TX,8.50\n03/11/2026,SHELL OIL 57444 AUSTIN TX,52.00\n03/12/2026,QT 421 DALLAS TX,12.25\n');
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 1000 }, reducedMotion: 'reduce' })).newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(m.text()); });
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.setInputFiles('#file', [path.join(ROOT, 'samples', 'FAKE-jan-feb-amex.csv'), tmp]);
  await page.waitForSelector('#panel-budget:not([hidden])');

  const gl = async () => { await page.click('#tab-fs'); await page.selectOption('#fs-page', 'gl'); };
  const row = (text, amount) => page.locator('#out tbody tr', { hasText: text }).filter({ hasText: amount }).first();
  const cat = async (text, amount) => (await row(text, amount).innerText()).replace(/\s+/g, ' ');

  // an account for convenience-store purchases, like the one you made
  await page.click('#gear'); await page.locator('#settings-body .menu-row', { hasText: 'TB coding' }).click();
  await page.click('#new-account');
  await page.fill('#acct-name', 'convenient store'); await page.selectOption('#acct-kind', 'free');
  await page.click('#settings-body .sub-add button:text-is("Add")');
  const added = await page.textContent('#settings-body');
  check('a convenience-store account is added', /Added 5\d00 convenient store/.test(added));
  await page.click('#settings-close');

  await gl();
  check('before turning it on, a small Shell charge is gas like the rest', /5490/.test(await cat('SHELL OIL', '8.50')), await cat('SHELL OIL', '8.50'));

  await page.click('#tab-code');
  await page.click('#code-fuel summary');
  check('the account that looks like a convenience store is picked for you', (await page.locator('#fuel-below option:checked').textContent()).includes('convenient store'));
  check('the cutoff starts at $25', (await page.inputValue('#fuel-cutoff')) === '25');
  await page.click('#fuel-on');
  check('turning it on says so', (await page.getAttribute('#fuel-on', 'aria-checked')) === 'true' && /splitting by amount/.test(await page.textContent('#code-fuel summary')));

  await gl();
  check('a small Shell charge now files as convenience', /convenient store/.test(await cat('SHELL OIL', '8.50')), await cat('SHELL OIL', '8.50'));
  check('and a small charge at another gas station does too', /convenient store/.test(await cat('QT 421', '12.25')), await cat('QT 421', '12.25'));
  check('a fill-up stays as gas', /5490/.test(await cat('SHELL OIL', '52.00')), await cat('SHELL OIL', '52.00'));

  // moving the cutoff moves the charges, past ones included
  await page.click('#tab-code');
  await page.fill('#fuel-cutoff', '60'); await page.press('#fuel-cutoff', 'Tab');
  await gl();
  check('raising the cutoff to $60 moves the $52 charge too', /convenient store/.test(await cat('SHELL OIL', '52.00')), await cat('SHELL OIL', '52.00'));
  await page.click('#tab-code');
  await page.fill('#fuel-cutoff', '25'); await page.press('#fuel-cutoff', 'Tab');

  // your own choice on one charge beats the split
  await gl();
  const small = row('SHELL OIL', '8.50');
  await small.locator('.linkbtn').first().click();
  await small.locator('select').selectOption('free_groceries');
  check('a charge you code yourself stays where you put it', /5430/.test(await cat('SHELL OIL', '8.50')));
  check('and coding it does not recode the merchant\'s other charges', /5490/.test(await cat('SHELL OIL', '52.00')) && /convenient store/.test(await cat('QT 421', '12.25')));

  // off again: back to gas
  await page.click('#tab-code');
  await page.click('#fuel-on');
  await gl();
  check('turning it off sends small charges back to gas', /5490/.test(await cat('QT 421', '12.25')), await cat('QT 421', '12.25'));

  check('no errors or security-policy violations', problems.length === 0, JSON.stringify(problems));
  await browser.close(); server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
});
