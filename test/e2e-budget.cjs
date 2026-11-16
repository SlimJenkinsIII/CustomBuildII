// The three-phase budget in a real browser: pay details from one paystub, paychecks read as normal or bonus, the 401(k) so far,
// savings tracked by account, and the free-cash verdict.   NODE_PATH=$(npm root -g) node test/e2e-budget.cjs
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
const HEAD = 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n';
const line = (d, desc, amt, bal = '') => `${amt < 0 ? 'DEBIT' : 'CREDIT'},${d},"${desc}",${amt.toFixed(2)},ACH,${bal},,\n`;

server.listen(0, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgt-'));
  const write = (n, t) => { const p = path.join(dir, n); fs.writeFileSync(p, t); return p; };
  const checking = write('Chase1044_Activity.CSV', HEAD
    + line('02/06/2026', 'ACME CORP PAYROLL', 2700)
    + line('02/10/2026', 'Online Transfer to SAV ...8527 transaction#: 5551', -400)
    + line('02/14/2026', 'CHIPOTLE 1234', -25)
    + line('02/20/2026', 'ACME CORP PAYROLL', 4050));
  const savings = write('Chase8527_Activity.CSV', HEAD + line('02/10/2026', 'Online Transfer from CHK ...1044 transaction#: 5551', 400));

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 1100 }, reducedMotion: 'reduce' })).newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.click('#gear'); await page.locator('#settings-body .menu-row', { hasText: 'Accounts' }).click();
  await page.fill('#acct-paste', 'Chase Checkings (1044)\nChase Savings (8527)'); await page.click('#acct-paste-go');
  await page.waitForFunction(() => /Added Chase Savings/.test(document.getElementById('settings-body').textContent));
  await page.click('#settings-close');
  await page.setInputFiles('#file', [checking, savings]);
  await page.waitForFunction(() => /Added 5 transactions/.test(document.getElementById('status').textContent), null, { timeout: 15000 });

  // the plan: pay details from one paystub, and a savings target for the savings account
  await page.click('#tab-budget');
  await page.locator('#plan-details summary').click();
  await page.selectOption('#pay-every', 'biweekly');
  await page.fill('#pay-gross', '4000'); await page.fill('#pay-take', '2700'); await page.fill('#pay-pct', '10'); await page.fill('#pay-match', '4'); await page.fill('#pay-limit', '24500');
  await page.click('#pay-save');
  await page.waitForFunction(() => /Usual take-home: \$5,850 a month/.test(document.getElementById('plan-body').textContent));
  check('pay details give the usual take-home: the yearly total spread over 12 months', true);
  check('the take-home box by hand is gone once pay details are in', (await page.locator('#plan-income').count()) === 0);
  await page.fill('#plan-acct-savings-8527', '500'); await page.press('#plan-acct-savings-8527', 'Tab');
  check('free cash is what is left after savings and fixed bills (5,850 less the sample plan\'s 3,350 and the 500 to savings)', /Free cash: \$2,000 a month/.test(await page.textContent('#plan-summary')), await page.textContent('#plan-summary'));

  // Month in review
  await page.selectOption('#month', '2026-02');
  const card = await page.textContent('#monthcard');
  check('paychecks are counted at their normal amount', /\$5,400 of \$5,850/.test(await page.textContent('#m-pay')), await page.textContent('#m-pay'));
  check('the bonus part is shown on its own as extra cash', /\$1,350/.test(await page.textContent('#m-extra')));
  check('and it is not savings and does not change free cash', /yours to use however you like/.test(card));
  check('the 401(k) is worked out, bonus included, with the year so far against the limit', /\$1,000/.test(await page.textContent('#m-401k')) && /401\(k\) so far this year: \$1,000 of the \$24,500 limit/.test(await page.textContent('#m-401k-ytd')), (await page.textContent('#m-401k')) + ' / ' + (await page.textContent('#m-401k-ytd')));
  check('savings are tracked from what moved into the account', /\$400 of \$500/.test(await page.textContent('#m-save-savings-8527')), await page.textContent('#m-save-savings-8527'));
  check('the verdict is free cash against spending', /under free cash|over free cash/.test(card));

  // the plan reads in order: income, then savings account by account, then fixed bills
  const planText = await page.textContent('#plan-body');
  const at = t => planText.indexOf(t);
  check('savings comes straight after income, before fixed bills', at('1. Income') >= 0 && at('1. Income') < at('2. Savings') && at('2. Savings') < at('3. Fixed'), [at('1. Income'), at('2. Savings'), at('3. Fixed')].join(','));
  check('the 401(k) is shown as savings already taken out of pay', /401\(k\): \$867 a month/.test(await page.textContent('#plan-401k')), await page.textContent('#plan-401k'));
  check('Month in review lists each savings account right after income', /2\. Savings, account by account/.test(await page.textContent('#monthcard')));

  // add an account (even one marked Checking): it shows up in the plan; give it a target; remove it and the target stops counting
  await page.click('#gear'); await page.locator('#settings-body .menu-row', { hasText: 'Accounts' }).click();
  await page.locator('#settings-body summary', { hasText: 'Add one account' }).click();
  await page.fill('#acct-new-name', 'Emergency fund (7777)'); await page.selectOption('#acct-new-kind', 'checking'); await page.fill('#acct-new-last4', '7777');
  await page.click('#acct-new-add');
  await page.waitForFunction(() => /Added Emergency fund/.test(document.getElementById('settings-body').textContent));
  await page.click('#settings-close');
  await page.click('#tab-budget');
  check('an account you add appears in the savings part of the plan', (await page.locator('#plan-acct-checking-7777').count()) === 1);
  await page.fill('#plan-acct-checking-7777', '100'); await page.press('#plan-acct-checking-7777', 'Tab');
  check('its target comes out of free cash', /Free cash: \$1,900 a month/.test(await page.textContent('#plan-summary')), await page.textContent('#plan-summary'));
  await page.click('#gear'); await page.locator('#settings-body .menu-row', { hasText: 'Accounts' }).click();
  await page.click('#acctremove-checking-7777'); await page.click('#acctremove-checking-7777');
  await page.waitForFunction(() => /are removed/.test(document.getElementById('settings-body').textContent));
  await page.click('#settings-close');
  await page.click('#tab-budget');
  check('remove the account and it leaves the plan, and its target stops counting', (await page.locator('#plan-acct-checking-7777').count()) === 0 && /Free cash: \$2,000 a month/.test(await page.textContent('#plan-summary')), await page.textContent('#plan-summary'));

  check('no errors', problems.length === 0, JSON.stringify(problems));
  await browser.close(); server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
});
