// Files the app doesn't know yet, in a real browser: it asks once which column is which, shows a preview, reads the file, and
// remembers the answer for the next file like it. An Amex savings file (same columns as the card) is read by its columns too.
//   NODE_PATH=$(npm root -g) node test/e2e-mapped.cjs
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const SITE = path.join(__dirname, '..', 'app');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]; const file = path.join(SITE, url === '/' ? 'index.html' : url);
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' }); res.end(fs.readFileSync(file));
});
let failures = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) failures++; };
const BROKER = (rows) => ['Account: Individual ...3013', 'As of 11/27/2026', '', 'Trade Date,Description,Type,Amount In,Amount Out,Cash Balance', ...rows].join('\n');

server.listen(0, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'map-'));
  const write = (n, t) => { const p = path.join(dir, n); fs.writeFileSync(p, t); return p; };
  const jan = write('JPM3013_activity_jan.csv', BROKER(['01/05/2026,TRANSFER FROM CHASE CHECKING,Deposit,"1,000.00",,"1,000.00"', '01/06/2026,BOUGHT 5 VTI,Buy,,900.00,100.00', '01/31/2026,DIVIDEND VTI,Dividend,3.10,,103.10']));
  const feb = write('JPM3013_activity_feb.csv', BROKER(['02/02/2026,WITHDRAWAL TO CHASE,Withdrawal,,50.00,53.10']));
  const hysa = write('AmexSavings6348.csv', 'Date,Description,Amount\n03/01/2026,INTEREST PAYMENT,1.25\n03/02/2026,TRANSFER FROM CHECKING,500.00\n');

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 1100 }, reducedMotion: 'reduce' })).newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.click('#gear'); await page.locator('#settings-body .menu-row', { hasText: 'Accounts' }).click();
  await page.fill('#acct-paste', 'Chase Checkings (1044)\nJPMorgan (3013)\nAmex High-Yield Savings (6348)'); await page.click('#acct-paste-go');
  await page.waitForFunction(() => /Added JPMorgan/.test(document.getElementById('settings-body').textContent));
  await page.click('#settings-close');
  const status = () => page.textContent('#status');

  // the brokerage file: read on its own, no questions; buys and sells left out; it goes to the account its digits name
  await page.setInputFiles('#file', [jan]);
  await page.waitForFunction(() => /Added 2 transactions/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('a brokerage file is read without any questions', (await page.locator('#col-overlay').count()) === 0 && (await page.locator('#ask-overlay').count()) === 0, await status());
  check('it goes into the account its digits name, with the buy left out', /Went into: JPMorgan \(3013\) \(2\)/.test(await status()), await status());

  // the checking side of the deposit says only "JPMORGAN CHASE DEBIT": it still pairs with the brokerage deposit, and the dividend files itself
  await page.setInputFiles('#file', [write('Chase1044_Activity.CSV', 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\nDEBIT,01/02/2026,"JPMORGAN CHASE DEBIT",-1000.00,ACH_DEBIT,,\n')]);
  await page.waitForFunction(() => /Added 1 transaction/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  await page.click('#tab-fs'); await page.selectOption('#fs-page', 'gl');
  const pair = (await page.locator('#out tbody tr', { hasText: /JPMORGAN CHASE DEBIT|TRANSFER FROM CHASE CHECKING/ }).allInnerTexts()).map(x => x.replace(/\s+/g, ' '));
  check('checking to brokerage pairs up as a transfer with no "transfer" wording', pair.length === 2 && pair.every(x => /Transfer \(not spending\)/.test(x) && !/other half not imported/.test(x)), pair.join(' | '));
  const div = (await page.locator('#out tbody tr', { hasText: 'DIVIDEND VTI' }).allInnerTexts()).join(' ').replace(/\s+/g, ' ');
  check('a brokerage dividend is filed by itself, not left for review', /Investment gains/.test(div) && !/Needs review/.test(div), div);

  // a file with no digits in its name: the account number written at the top of the file is enough
  await page.setInputFiles('#file', [write('activity.csv', BROKER(['02/02/2026,WITHDRAWAL TO CHASE ...1044,Withdrawal,,50.00,53.10']))]);
  await page.waitForFunction(() => /Added 1 transaction/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('a file named only "activity.csv" is placed by the account number inside it (not by the transfer to 1044)', (await page.locator('#ask-overlay').count()) === 0 && /Went into: JPMorgan \(3013\)/.test(await status()), await status());

  // a file named with the account's number on your TB (JPMorgan is 1040 here), with no account details inside
  const tbCode = (await page.evaluate(() => 0), '1040');
  await page.setInputFiles('#file', [write(`Statement_${tbCode}.csv`, 'Trade Date,Description,Type,Amount In,Amount Out,Cash Balance\n03/03/2026,DIVIDEND VTI,Dividend,2.00,,55.10\n')]);
  await page.waitForFunction(() => /Added 1 transaction/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('a file named with the account’s TB number goes to that account', (await page.locator('#ask-overlay').count()) === 0 && /Went into: JPMorgan \(3013\)/.test(await status()), await status());

  // an Amex savings file: same columns as the Amex card, but its digits are a savings account: read by its columns, no questions
  await page.setInputFiles('#file', [hysa]);
  await page.waitForFunction(() => /Added 2 transactions/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('an Amex savings file goes into the savings account without questions, money in as money in', (await page.locator('#col-overlay').count()) === 0 && /Went into: Amex High-Yield Savings \(6348\) \(2\)/.test(await status()), await status());
  await page.click('#tab-fs'); await page.selectOption('#fs-page', 'gl');
  const gl = (await page.locator('#out tbody tr', { hasText: 'TRANSFER FROM CHECKING' }).allInnerTexts()).join(' ').replace(/\s+/g, ' ');
  check('the deposit shows as money in to the savings account', /Amex High-Yield Savings \(6348\)/.test(gl) && /\$500\.00/.test(gl) && !/−\$500/.test(gl), gl);

  // only a file it really can't make out asks, and then just once for that layout
  const odd = write('Export6348.csv', 'Posted,Memo,Value\n2026-04-01,INTEREST,1.10\n2026-04-02,TRANSFER IN,20.00\n');
  await page.setInputFiles('#file', [odd]);
  await page.waitForSelector('#col-overlay');
  check('a file it can’t make out asks which column is which', /Export6348/.test(await page.textContent('#col-overlay')));
  await page.selectOption('#col-date', 'Posted'); await page.selectOption('#col-desc', 'Memo'); await page.selectOption('#col-amount', 'Value');
  await page.click('#col-ok');
  await page.waitForFunction(() => /Added 2 transactions/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  await page.setInputFiles('#file', [write('Export6348b.csv', 'Posted,Memo,Value\n2026-05-01,INTEREST,1.20\n')]);
  await page.waitForFunction(() => /Added 1 transaction/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('and the next file like it is read without asking', (await page.locator('#col-overlay').count()) === 0);

  // a brokerage file for an account not set up yet: you add it while uploading; its number (from inside the file) is filled in and kept,
  // and the account stays even if you undo the upload
  const newOne = write('brokerage_activity.csv', ['Trade Date,Settlement Date,Account,Description,Symbol,Quantity,Price,Amount', '01/05/2026,01/05/2026,XXXX7788,ELECTRONIC FUNDS TRANSFER RECEIVED,,,,"1,000.00"', '01/06/2026,01/07/2026,XXXX7788,BOUGHT VTI,VTI,5,180,-900.00', '01/31/2026,01/31/2026,XXXX7788,DIVIDEND VTI,VTI,,,3.10'].join('\n'));
  await page.setInputFiles('#file', [newOne]);
  await page.waitForSelector('#ask-overlay');
  check('the account number written in the file is filled in for the new account', (await page.inputValue('#ask-last4')) === '7788');
  await page.selectOption('#ask-account', '__new'); await page.selectOption('#ask-kind', 'investment'); await page.fill('#ask-name', 'JPMorgan Brokerage'); await page.click('#ask-ok');
  await page.waitForFunction(() => /Went into: JPMorgan Brokerage/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  await page.click('#undo-import');
  await page.click('#gear'); await page.locator('#settings-body .menu-row', { hasText: 'Accounts' }).click();
  check('an account you created while uploading stays, even after Undo', (await page.locator('#acctname-investment-7788').count()) === 1 && (await page.inputValue('#acctdig-investment-7788')) === '7788');
  await page.click('#settings-close');
  await page.setInputFiles('#file', [newOne]);
  await page.waitForFunction(() => /Went into: JPMorgan Brokerage \(2\)/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('and the next upload of that file goes straight to it, no questions', (await page.locator('#ask-overlay').count()) === 0);

  // the layouts can be seen and forgotten
  await page.click('#gear'); await page.locator('#settings-body .menu-row', { hasText: 'Accounts' }).click();
  await page.locator('#formats-box summary').click();
  check('Accounts lists the file layouts it learned', /File layouts I’ve learned \(\d\)/.test(await page.textContent('#formats-box')));
  await page.click('#format-forget-0');
  await page.waitForFunction(() => /Forgotten/.test(document.getElementById('settings-body').textContent));
  check('and one can be forgotten', true);

  check('no errors', problems.length === 0, JSON.stringify(problems));
  await browser.close(); server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
});
