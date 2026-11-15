// Accounts and file linking, in a real browser, following what actually happened: a checking file and a savings file were both
// imported into one account, and the user had coded some of the lines by hand.   NODE_PATH=$(npm root -g) node test/e2e-accounts.cjs
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

const HEAD = 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n';
const line = (d, desc, amt) => `${amt < 0 ? 'DEBIT' : 'CREDIT'},${d},"${desc}",${amt.toFixed(2)},ACCT_XFER,0,,\n`;

server.listen(0, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accts-'));
  const write = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
  // everything imported together before there were separate accounts: checking lines and savings lines in one file
  const merged = write('all-chase.csv', HEAD
    + line('01/05/2026', 'ACME CORP PAYROLL', 3000)
    + line('01/19/2026', 'Online Transfer to SAV ...8527 transaction#: 31092522089', -400)
    + line('01/19/2026', 'Online Transfer from CHK ...1044 transaction#: 31092522089', 400)
    + line('01/31/2026', 'LOYALTY REWARD', 4.5));
  // the savings statement on its own, as downloaded later, and a second savings account nobody has set up yet
  const savings = write('Chase8527_Activity_20260201.CSV', HEAD
    + line('01/19/2026', 'Online Transfer from CHK ...1044 transaction#: 31092522089', 400)
    + line('01/31/2026', 'LOYALTY REWARD', 4.5)
    + line('02/28/2026', 'LOYALTY REWARD', 5.1));
  const other = write('Chase1899_Activity_20260201.CSV', HEAD + line('02/03/2026', 'LOYALTY REWARD', 1.25));

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 1000 }, reducedMotion: 'reduce' })).newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(m.text()); });
  await page.goto(`http://localhost:${server.address().port}/`);
  const gl = async () => { await page.click('#tab-fs'); await page.selectOption('#fs-page', 'gl'); };
  const glRows = text => page.locator('#out tbody tr', { hasText: text });
  const status = () => page.textContent('#status');

  await page.setInputFiles('#file', [merged]);
  await page.waitForSelector('#panel-budget:not([hidden])');
  check('a file with no digits goes to the one account that exists, as before', /Added 4 transactions/.test(await status()), await status());

  // code the interest by hand, as the user did
  await page.click('#tab-code');
  await page.locator('#code-rows tr', { hasText: 'LOYALTY REWARD' }).first().locator('input[type=checkbox]').check();
  await page.selectOption('#code-choose', 'other_interest'); await page.click('#code-apply');
  await page.waitForFunction(() => /coded as/.test(document.getElementById('code-note').textContent));

  // set up the accounts by pasting the list
  await page.click('#gear'); await page.locator('#settings-body .menu-row', { hasText: 'Accounts' }).click();
  await page.fill('#acct-paste', 'Chase Checkings (1044)\nChase Savings (8527)\nAmex High-Yield Savings (6348)\nCoinbase');
  await page.click('#acct-paste-go');
  await page.waitForFunction(() => /Linked 1 account/.test(document.getElementById('settings-body').textContent));
  const msg = await page.textContent('#settings-body');
  check('the first checking account takes over the one that exists, and a savings account is added', /Linked 1 account to the ones already there/.test(msg) && /Added Chase Savings \(8527\)/.test(msg));
  check('accounts with no file import yet are named and left alone', /No file import for these yet.*Amex High-Yield Savings \(6348\).*Coinbase/.test(msg));
  check('the checking account is renamed and has its digits', (await page.inputValue('#acctname-chase-checking')) === 'Chase Checkings (1044)' && (await page.inputValue('#acctdig-chase-checking')) === '1044');
  check('the savings account has its digits and is an asset', (await page.inputValue('#acctdig-chase-bank-8527')) === '8527' && /asset|Chase bank/i.test(await page.textContent('#settings-body')));
  await page.click('#settings-close');

  // upload the savings file under its own name: it is recognised by its digits, and the lines already in are MOVED
  await page.setInputFiles('#file', [savings]);
  await page.waitForFunction(() => /moved/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  const s1 = await status();
  check('the savings file is recognised by its digits without asking', (await page.locator('#ask-overlay').count()) === 0, s1);
  check('lines already imported are moved into it, not added twice, and the new one is added', /Added 1 transaction/.test(s1) && /moved 2 ones you already had into Chase Savings \(8527\)/.test(s1) && /your choices on them are kept/.test(s1), s1);

  await gl();
  const interest = (await glRows('LOYALTY REWARD').allInnerTexts()).map(t => t.replace(/\s+/g, ' '));
  check('your hand-coded interest keeps its coding after it moves', interest.some(t => /Jan 31/.test(t) && /Chase Savings \(8527\)/.test(t) && /Interest income/.test(t)), interest.join(' | '));
  const xfer = (await glRows('transaction#: 31092522089').allInnerTexts()).map(t => t.replace(/\s+/g, ' '));
  check('the two halves of the transfer are now in different accounts and pair up as a transfer', xfer.length === 2 && xfer.every(t => /Transfer \(not spending\)/.test(t)) && xfer.some(t => /Chase Checkings \(1044\)/.test(t)) && xfer.some(t => /Chase Savings \(8527\)/.test(t)), xfer.join(' | '));

  // the same file again adds nothing
  await page.setInputFiles('#file', [savings]);
  await page.waitForFunction(() => /Added 0 transactions/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('importing the same file again adds nothing and moves nothing', !/moved/.test(await status()), await status());

  // a file with digits nobody has set up: asked once
  await page.setInputFiles('#file', [other]);
  await page.waitForSelector('#ask-overlay');
  check('digits that are not set up are asked about, with the file named', /Chase1899_Activity/.test(await page.textContent('#ask-overlay')) && (await page.inputValue('#ask-last4')) === '1899');
  await page.selectOption('#ask-account', '__new');
  await page.fill('#ask-name', 'Chase Savings (1899)'); await page.click('#ask-ok');
  await page.waitForFunction(() => /Added 1 transaction/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  await gl();
  check('the new account is created and the file goes into it', (await glRows('LOYALTY REWARD').allInnerTexts()).some(t => /Chase Savings \(1899\)/.test(t)));
  await page.setInputFiles('#file', [other]);
  await page.waitForFunction(() => /Added 0 transactions/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('and next time that file is recognised without asking', (await page.locator('#ask-overlay').count()) === 0);

  // the Balance Sheet lists the accounts, each with its own balance
  await page.click('#tab-fs'); await page.selectOption('#fs-page', 'bs');
  await page.click('#fs-bs .expand-all');
  const bs = await page.locator('#fs-bs').textContent();
  check('the Balance Sheet shows each account on its own', ['Chase Checkings (1044)', 'Chase Savings (8527)', 'Chase Savings (1899)'].every(n => bs.includes(n)));

  // Venmo: one account of its own kind, so its file needs no question; and it can be set to sit under Checking
  await page.setInputFiles('#file', [path.join(ROOT, 'samples', 'FAKE-venmo.csv')]);
  await page.waitForFunction(() => /Went into: Venmo balance \(5\)/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('a Venmo file goes to the Venmo account without asking, and the message says so', (await page.locator('#ask-overlay').count()) === 0 && /Went into: Venmo balance \(5\)/.test(await status()), await status());
  await page.click('#gear'); await page.locator('#settings-body .menu-row', { hasText: 'TB coding' }).click();
  await page.click('#new-account');
  await page.fill('#acct-name', 'Checking'); await page.selectOption('#acct-kind', 'header');
  await page.click('#settings-body .sub-add button:text-is("Add")');
  const head = (await page.textContent('#settings-body')).match(/Added (\d{4}) Checking/)[1];
  await page.click('#settings-back');
  await page.locator('#settings-body .menu-row', { hasText: 'Accounts' }).click();
  check('the Accounts screen shows how many items each account has, Venmo included', /Venmo balance|1030/.test(await page.textContent('#acct-list')) && /5 items/.test(await page.textContent('#acct-list')));
  await page.selectOption('#acctunder-venmo', { label: `${head} Checking` });
  await page.waitForFunction(() => /Venmo balance now sits under Checking/.test(document.getElementById('settings-body').textContent));
  const vcode = (await page.textContent('#acct-list')).match(/(\d{4}) · Venmo/)[1];
  check('Venmo now sits under Checking, and its number follows (the next ten under it)', Number(vcode) > Number(head) && Number(vcode) < Number(head) + 100 && vcode.endsWith('0'), `${head} -> ${vcode}`);
  await page.click('#settings-close');
  await page.click('#tab-fs'); await page.selectOption('#fs-page', 'bs');
  await page.click('#fs-bs .expand-all');
  check('on the Balance Sheet, Venmo is indented under Checking', (await page.locator('#fs-bs tr:has-text("Venmo balance") td.acct.sub-acct').count()) === 1);
  await page.click('#gear'); await page.locator('#settings-body .menu-row', { hasText: 'Accounts' }).click();
  await page.selectOption('#acctunder-venmo', '');
  await page.waitForFunction(() => /Venmo balance now sits on its own/.test(document.getElementById('settings-body').textContent));
  check('and it can be put back on its own', true);
  await page.click('#settings-close');

  // undo takes the last import back
  await page.setInputFiles('#file', [write('Chase8527_Activity_20260301.CSV', HEAD + line('03/05/2026', 'LOYALTY REWARD', 9.99))]);
  await page.waitForFunction(() => /Added 1 transaction/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('an undo link appears after an import', await page.locator('#undo-import').isVisible());
  await page.click('#undo-import');
  check('undo takes that import back', /Import undone/.test(await status()) && (await page.locator('#undo-import').isHidden()));

  check('no errors or security-policy violations', problems.length === 0, JSON.stringify(problems));
  await browser.close(); server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
});
