// Importing a Venmo CSV in a real browser.   NODE_PATH=$(npm root -g) node test/e2e-venmo.cjs
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
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 1000 }, reducedMotion: 'reduce' })).newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(m.text()); });
  await page.goto(`http://localhost:${server.address().port}/`);
  const samples = f => path.join(ROOT, 'samples', f);
  // a bank file with the bare VENMO PAYMENT line, and both halves of one transfer between two of your Chase accounts
  const bank = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'venmo-')), 'bank.csv');
  fs.writeFileSync(bank, 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n'
    + 'DEBIT,03/06/2026,"VENMO PAYMENT 1053903953802 WEB ID: 3264681992",-60.00,ACH_DEBIT,100.00,,\n'
    + 'DEBIT,03/07/2026,"Online Transfer to SAV ...8527 transaction#: 31092522089",-200.00,ACCT_XFER,100.00,,\n'
    + 'CREDIT,03/07/2026,"Online Transfer from CHK ...1044 transaction#: 31092522089",200.00,ACCT_XFER,300.00,,\n');
  await page.setInputFiles('#file', [samples('FAKE-chase-checking.csv'), samples('FAKE-venmo.csv'), bank]);
  await page.waitForSelector('#panel-budget:not([hidden])');
  const status = await page.textContent('#status');
  check('the Venmo file imports', /Added \d+ transactions/.test(status), status);
  check('it says one bank-funded payment was left out, and why', /1 Venmo payment you funded from a bank or card was not counted again/.test(status));

  await page.click('#tab-fs'); await page.selectOption('#fs-page', 'gl');
  const rows = await page.locator('#out tbody tr', { hasText: 'Venmo balance' }).allInnerTexts();
  check('Venmo shows as its own account in GL Detail', rows.length === 5, `${rows.length} rows`);
  check('a friend paying you is left for you to sort', rows.some(t => /FROM PAT EXAMPLE/.test(t) && /5900/.test(t)), rows.filter(t => /PAT EXAMPLE/.test(t)).join(' | ').replace(/\s+/g, ' '));
  check('a payment you made from your Venmo balance is an item to sort too', rows.some(t => /TO SAM SAMPLE: Rent share/.test(t) && /5900/.test(t)));
  check('the cash-out to the bank is held as a transfer, not spending', rows.some(t => /VENMO TRANSFER TO BANK/.test(t) && !/5900/.test(t)));

  const reworded = await page.locator('#out tbody tr', { hasText: 'TO RILEY DEMO: Concert tickets' }).allInnerTexts();
  check('a bare VENMO PAYMENT on the bank now says who you paid and why', reworded.length === 1 && /Chase checking/.test(reworded[0]) && /5900/.test(reworded[0]), reworded.join(' | ').replace(/\s+/g, ' '));
  check('the original bank wording is gone from the list, and the payment is not counted twice', (await page.locator('#out tbody tr', { hasText: '1053903953802' }).count()) === 0 && (await page.locator('#out tbody tr', { hasText: 'Concert tickets' }).count()) === 1);
  const xfer = await page.locator('#out tbody tr', { hasText: 'transaction#: 31092522089' }).allInnerTexts();
  check('the two halves of a transfer between your own accounts pair up and are not spending', xfer.length === 2 && xfer.every(t => /Transfer \(not spending\)/.test(t)), xfer.join(' | ').replace(/\s+/g, ' '));
  await page.click('#gear'); await page.locator('#settings-body .menu-row', { hasText: 'Opening balances' }).click();
  check('Venmo balance can be given an opening balance, like checking', /Venmo balance/.test(await page.textContent('#settings-body')));
  await page.click('#settings-close');

  await page.click('#tab-code');
  check('the Venmo items that need sorting show up in the Coding tab', (await page.locator('#code-rows tr', { hasText: 'SAM SAMPLE' }).count()) === 1);

  check('no errors or security-policy violations', problems.length === 0, JSON.stringify(problems));
  await browser.close(); server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
});
