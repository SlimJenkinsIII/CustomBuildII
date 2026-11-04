// End-to-end test: the real app in a real browser, with its real security rules on.
// Covers tabs, saving, locking, encryption at rest, backup and restore, plan, trips, TB coding,
// GL detail filters, category choices, and dummy numbers.
// Needs Playwright (not a project dependency):  NODE_PATH=$(npm root -g) npm run e2e
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
// By default this serves app/. To test what actually gets published, build it with scripts/build-site.sh and run:
//   SITE_DIR=_site E2E_PREFIX=/your-repo-name/ npm run e2e      (GitHub serves project sites under a subfolder)
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
const SAMPLES = ['FAKE-jan-feb-chase-checking.csv', 'FAKE-jan-feb-chase-card.csv', 'FAKE-jan-feb-amex.csv', 'FAKE-chase-checking.csv', 'FAKE-chase-card.csv', 'FAKE-amex.csv']
  .map(f => path.join(ROOT, 'samples', f));
const PASS = 'correct horse battery';
let failures = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) failures++; };

server.listen(0, async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(m.text()); });
  const BASE = `http://localhost:${server.address().port}${PREFIX}`;
  const URL = `${BASE}index.html`;

  const body = () => page.evaluate(() => document.body.textContent);
  const txCount = async () => Number((await page.textContent('#gl-count')).match(/(\d+) of|^(\d+)/).slice(1).find(Boolean));
  const chip = () => page.textContent('#savechip');
  const saved = () => page.waitForFunction(() => document.getElementById('savechip').textContent === 'Saved on this device', null, { timeout: 15000 });
  const envelopeText = () => page.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open('my-budget', 1);
    r.onsuccess = () => { const g = r.result.transaction('vault').objectStore('vault').get('envelope'); g.onsuccess = () => res(g.result === undefined ? null : JSON.stringify(g.result)); g.onerror = () => rej(g.error); };
    r.onerror = () => rej(r.error);
  }));
  const gear = async screen => {
    await page.click('#gear');
    if (screen) await page.locator('#settings-body .menu-row', { hasText: screen }).click();
  };
  const closeSheet = () => page.click('#settings-close');
  const glRow = text => page.locator('#out tbody tr', { hasText: text }).first();
  const goFS = async pg => { await page.click('#tab-fs'); await page.click(`#fs-nav [data-page="${pg}"]`); };
  const onGL = async () => (await page.getAttribute('#tab-fs', 'aria-selected')) === 'true' && (await page.getAttribute('#fs-nav [data-page="gl"]', 'aria-pressed')) === 'true';

  // ---------- layout ----------
  await page.goto(URL);
  if (process.env.SITE_DIR) {
    // the published test-files page: every link must download a real CSV
    const tf = await page.request.get(`${BASE}test-files.html`);
    check('the test-files page is published', tf.ok());
    const links = [...(await tf.text()).matchAll(/href="(samples\/[^"]+\.csv)"/g)].map(m => m[1]);
    const got = await Promise.all(links.map(async l => { const r = await page.request.get(BASE + l); return r.ok() && (await r.text()).split('\n')[0].length > 10; }));
    check('all six made-up statements download', links.length === 6 && got.every(Boolean), `(${links.length} links)`);
    check('no real statements ride along', !fs.readdirSync(path.join(SITE, 'samples')).some(f => !f.startsWith('FAKE-')));
  }
  check('starts empty, unlocked', await page.locator('#empty').isVisible() && await page.locator('#lock').isHidden());
  // ---------- other sites cannot show this app in a frame ----------
  check('the app reveals itself when it is the top-level page', await page.evaluate(() => getComputedStyle(document.documentElement).display !== 'none' && !document.getElementById('antiframe')));
  const framer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<iframe id="f" src="${URL}" width="900" height="700"></iframe>`); });
  await new Promise(resolve => framer.listen(0, resolve));
  const other = await ctx.newPage();
  await other.goto(`http://127.0.0.1:${framer.address().port}/`);          // a different address, like an attacker's page
  await other.frameLocator('#f').locator('body').waitFor({ state: 'attached' });
  const inner = other.frames().find(f => f !== other.mainFrame());
  await inner.waitForLoadState('load');
  check('inside another site\'s frame the app stays hidden', (await inner.evaluate(() => getComputedStyle(document.documentElement).display)) === 'none');
  check('and none of its controls can be reached or seen there', !(await inner.locator('#gear').isVisible()) && !(await inner.locator('#file').isVisible()));
  await other.close(); framer.close();

  const labels = await page.locator('[role=tab]').allTextContents();
  check('six tabs in the right order, with F/S replacing TB Summary and GL Detail', labels.join('|') === 'Summary|Budget|Investments|Savings|F/S|Tie-out', labels.join('|'));
  check('Budget is the landing tab', (await page.getAttribute('#tab-budget', 'aria-selected')) === 'true');
  for (const t of ['summary', 'investments', 'savings']) {
    await page.click(`#tab-${t}`);
    check(`${t} tab is a placeholder`, (await page.locator(`#panel-${t}`).textContent()).includes('Coming later'));
  }
  await page.click('#tab-budget');
  await page.click('#gear');
  const menu = (await page.locator('#settings-body .menu-row').allTextContents()).join(' | ');
  check('settings has TB coding, Trips, Saving & backup, Dummy numbers', /TB coding/.test(menu) && /Trips/.test(menu) && /Saving & backup/.test(menu) && /Dummy numbers/.test(menu));
  check('settings shows no stray text', !/\b(false|undefined|null)\b/.test(await page.textContent('#settings-body')));
  await page.keyboard.press('Escape');
  check('Escape closes settings', await page.locator('#settings').isHidden());

  // ---------- load ----------
  await page.setInputFiles('#file', SAMPLES);
  await page.waitForSelector('#panel-budget:not([hidden]) #bgt-summary .hero-num');
  const n = await txCount();
  check('statements load', n === 74, `(${n} transactions)`);
  check('banner warns data is not saved', await page.locator('#savebanner').isVisible() && (await chip()) === 'Not saved yet');

  // ---------- the Budget tab looks back ----------
  check('Budget is a look back, with no "This week" card', (await page.textContent('#bgt-title')) === 'Last 4 weeks' && !(await body()).includes('This week'));
  check('it leads with the effect on savings', /^[+\u2212]\$/.test((await page.textContent('#bgt-summary .hero-num')).trim()));
  const bars = () => page.locator('#bgt-weeks g.hit').count();
  check('week by week: one bar per full week (4)', (await bars()) === 4);
  await page.click('#bgt-summary button[aria-label="Last 8 weeks"]');
  check('8 weeks shows 8 bars and updates the heading', (await bars()) === 8 && (await page.textContent('#bgt-title')) === 'Last 8 weeks');
  await page.click('#bgt-summary button[aria-label="Year to date"]');
  check('year to date shows every full week this year (9)', (await bars()) === 9);
  await page.click('#bgt-summary button[aria-label="Last 4 weeks"]');
  check('the savings card has a running-total line', await page.locator('#bgt-savings svg path.line').count() === 1 && /since/.test(await page.textContent('#bgt-savings')));
  check('the numbers table is available behind the chart', (await page.locator('#bgt-weeks details tbody tr').count()) === 4);
  await page.locator('#bgt-weeks g.hit').first().click();
  check('tapping a week opens its transactions, with a way back', (await onGL()) && /^Week of/.test((await page.textContent('#chips')).trim()) && /Back to Budget/.test(await page.textContent('#gl-back')));
  await page.click('#gl-back');
  check('and Back returns to Budget', (await page.getAttribute('#tab-budget', 'aria-selected')) === 'true');
  check('Month in review defaults to the latest finished month', (await page.inputValue('#month')) === '2026-02');

  // ---------- passphrase ----------
  await page.click('#banner-btn');
  await page.fill('#sec-pass', 'short'); await page.fill('#sec-pass2', 'short'); await page.click('text=Save on this device');
  check('short passphrase refused', /at least 8/.test(await page.textContent('#sec-msg')));
  await page.fill('#sec-pass', PASS); await page.fill('#sec-pass2', 'something different'); await page.click('text=Save on this device');
  check('mismatched passphrase refused', /don.t match/.test(await page.textContent('#sec-msg')));
  await page.fill('#sec-pass', PASS); await page.fill('#sec-pass2', PASS); await page.click('text=Save on this device');
  await saved();
  check('saved on this device', true);
  await closeSheet();
  check('banner gone once saved', await page.locator('#savebanner').isHidden());

  // ---------- plan lives in Budget ----------
  check('plan is collapsed by default', !(await page.evaluate(() => document.getElementById('plan-details').open)));
  await page.click('#edit-plan');                            // the quiet "Edit plan" link
  check('"Edit plan" opens the plan', await page.evaluate(() => document.getElementById('plan-details').open));
  await page.fill('#plan-income', '5000'); await page.press('#plan-income', 'Tab');
  check('plan edit updates free cash', /Free cash: \$\d/.test(await page.textContent('#plan-summary')), await page.textContent('#plan-summary'));
  await page.fill('#plan-save_chase', '10%'); await page.press('#plan-save_chase', 'Tab');
  check('a percentage becomes dollars', (await page.inputValue('#plan-save_chase')) === '500' && (await page.textContent('#pct-save_chase')) === '10.0%',
    `${await page.inputValue('#plan-save_chase')} / ${await page.textContent('#pct-save_chase')}`);

  // ---------- trips ----------
  await gear('Trips');
  await page.fill('#trip-name', 'Lisbon'); await page.fill('#trip-start', '2026-03-05'); await page.fill('#trip-end', '2026-03-12');
  await page.click('text=Add trip');
  check('trip added in block 7100', (await page.textContent('#settings-body')).includes('7100') && (await page.textContent('#settings-body')).includes('Lisbon'));
  await closeSheet();

  // ---------- TB coding ----------
  await gear('TB coding');
  await page.fill('#code-free_groceries', '5455'); await page.press('#code-free_groceries', 'Tab');
  check('TB number changed', (await page.inputValue('#code-free_groceries')) === '5455');
  await page.fill('#code-free_coffee', '5455'); await page.press('#code-free_coffee', 'Tab');
  check('duplicate number refused with the reason', /5455 is already used by Groceries/.test(await page.textContent('#settings-body')));
  check('refused number snaps back', (await page.inputValue('#code-free_coffee')) === '5410');
  await page.fill('#code-free_gifts', '12'); await page.press('#code-free_gifts', 'Tab');
  check('non-4-digit number refused', /4-digit/.test(await page.textContent('#settings-body')));
  await closeSheet();
  await goFS('tb');
  check('TB Summary follows the new number', (await page.locator('#fs-tb').textContent()).includes('5455'));
  const codes = await page.locator('#fs-tb tbody tr:not(.hdr):not(.tot):not(.tot2):not(.net):not(.run) .code').allTextContents();
  check('TB Summary lists accounts in number order', codes.length > 10 && codes.join() === [...codes].sort().join(), codes.slice(0, 8).join(' '));
  check('TB Summary says every month balances', /Every month balances/.test(await page.locator('#fs-tb .mx-legend').textContent()));
  check('TB Summary is on the Balances view by default', (await page.locator('#fs-tb .seg [aria-pressed="true"]').textContent()) === 'Balances');
  await goFS('is');
  check('the Income Statement page is there, with its own layout', /Net operating income/.test(await page.locator('#fs-is').textContent()) && /Net income \(loss\)/.test(await page.locator('#fs-is').textContent()));
  await goFS('tb');

  // ---------- opening balances: the TB starts from them, then shows month-end balances ----------
  check('Balances is the default TB view, with an Opening column', /Opening/.test(await page.locator('#fs-tb thead').textContent()) && /Dec 31, 2025/.test(await page.locator('#fs-tb thead').textContent()));
  check('it nudges you to enter opening balances', /No opening balances yet/.test(await page.locator('#fs-tb').textContent()));
  await page.click('#fs-tb >> text=Enter opening balances');
  check('the opening date starts at 12/31/2024', (await page.inputValue('#open-date')) === '2024-12-31');
  await page.fill('#open-src-chase-checking', '1000'); await page.press('#open-src-chase-checking', 'Tab');
  await page.fill('#open-save_chase', '5000'); await page.press('#open-save_chase', 'Tab');
  await page.fill('#open-src-amex', '200'); await page.press('#open-src-amex', 'Tab');
  check('opening balance equity is shown', /Opening balance equity: \$5,800/.test(await page.textContent('#open-plug')), await page.textContent('#open-plug'));
  await page.fill('#open-src-amex', 'lots'); await page.press('#open-src-amex', 'Tab');
  check('a bad amount is refused with help', /Enter an amount/.test(await page.textContent('#settings-body')));
  await page.fill('#open-src-amex', '200'); await page.press('#open-src-amex', 'Tab');
  await closeSheet();
  const cells = async code => (await page.locator('#fs-tb tbody tr', { hasText: code }).first().locator('td').allTextContents()).map(t => t.trim());
  const sav = await cells('Chase Savings');
  check('savings: opening $5,000, January end $5,400 (400 moved in)', sav[1] === '5,000' && sav[2] === '5,400', sav.slice(0, 4).join(' | '));
  const eq = await cells('Opening balance equity');
  check('equity holds the difference and never moves', eq[1] === '(5,800)' && eq[2] === '(5,800)', eq.slice(0, 4).join(' | '));
  const inc = await cells('Paycheck');
  check('income is a year-to-date balance', inc[2] === '(4,200)' && inc[3] === '(8,400)', inc.slice(0, 5).join(' | '));
  const diff = await cells('Difference');
  check('every balance column adds to zero', diff.slice(1, 5).every(t => t === '\u2013'), diff.slice(0, 6).join(' | '));
  check('no more opening-balance nudge', !(await page.locator('#fs-tb').textContent()).includes('No opening balances yet'));
  await page.click('#fs-tb >> text=Activity');
  const actInc = await cells('Paycheck');
  check('the Activity view still shows each month\'s movement', actInc[1] === '(4,200)' && actInc[2] === '(4,200)', actInc.slice(0, 4).join(' | '));
  await page.click('#fs-tb >> text=Balances');

  // ---------- F/S: four pages ----------
  const pages = await page.locator('#fs-nav button').allTextContents();
  check('F/S has four pages, in order', pages.join('|') === 'TB Summary|Balance Sheet|Income Statement|GL Detail', pages.join('|'));
  await goFS('bs');
  const bsRow = async name => (await page.locator('#fs-bs tbody tr', { hasText: name }).first().locator('td').allTextContents()).map(t => t.trim());
  const num = t => Number(t.replace(/[(),]/g, ''));
  const assets = await bsRow('Total assets'), owed = await bsRow('Total liabilities'), equity = await bsRow('Total equity'), bsDiff = await bsRow('Difference');
  check('Balance Sheet opens with what you have: $6,000', assets[1] === '6,000', assets.slice(0, 3).join(' | '));
  check('...what you owe: $200', owed[1] === '200', owed.slice(0, 3).join(' | '));
  check('...and equity of $5,800', equity[1] === '5,800', equity.slice(0, 3).join(' | '));
  check('equity grows with earnings, month by month', num(equity[2]) > 5800 && num(equity[3]) > num(equity[2]), equity.slice(1, 4).join(' | '));
  check('assets equal liabilities plus equity in every column', bsDiff.slice(1, 5).every(t => t === '\u2013') && /Assets equal liabilities plus equity/.test(await page.locator('#fs-bs .mx-legend').textContent()), bsDiff.slice(0, 5).join(' | '));
  await page.locator('#fs-bs button.cell').first().click();
  check('a Balance Sheet number opens GL Detail, with a way back to the Balance Sheet', (await onGL()) && /Back to Balance Sheet/.test(await page.textContent('#gl-back')));
  await page.click('#gl-back');
  check('Back lands on the Balance Sheet', (await page.getAttribute('#fs-nav [data-page="bs"]', 'aria-pressed')) === 'true' && await page.locator('#fs-bs').isVisible());
  await goFS('tb');
  await page.locator('#fs-tb button.cell').first().click();
  check('a TB Summary number opens GL Detail, with a way back to TB Summary', (await onGL()) && /Back to TB Summary/.test(await page.textContent('#gl-back')));
  await page.click('#gl-back');
  check('Back lands on TB Summary, and GL Detail is no longer filtered', (await page.getAttribute('#fs-nav [data-page="tb"]', 'aria-pressed')) === 'true' && await page.locator('#fs-tb').isVisible());
  await goFS('gl');
  check('opening GL Detail directly shows everything, with no Back button', (await txCount()) === n && await page.locator('#gl-back').isHidden());
  await goFS('tb');

  // ---------- GL detail ----------
  await goFS('gl');
  check('GL Detail shows every transaction', (await txCount()) === n);
  const delta = glRow('DELTA AIR LINES');
  check('flight filed under the trip (7120)', (await delta.innerText()).includes('7120 Lisbon'), (await delta.innerText()).replace(/\s+/g, ' '));
  check('GL shows the renumbered account', (await glRow('WHOLEFDS').innerText()).includes('5455 Groceries'));
  await page.fill('#gl-q', 'delta');
  check('search narrows the list', (await page.locator('#out tbody tr').count()) === 1 && /1 of 74/.test(await page.textContent('#gl-count')));
  await page.click('text=Clear all filters');
  check('clearing filters brings everything back', (await page.locator('#out tbody tr').count()) === n);
  await page.selectOption('#gl-cat', 'free_groceries');
  check('GL account filter works', (await page.locator('#out tbody tr').count()) > 0 && (await page.locator('#out tbody tr').allInnerTexts()).every(t => t.includes('5455 Groceries')));
  await page.click('text=Clear all filters');
  const mag = glRow('MAGNOLIA CAFE');
  check('unknown merchant starts in review', (await mag.innerText()).includes('1900'));
  await mag.locator('.linkbtn').click();
  await mag.locator('select').selectOption('free_restaurants');
  check('category choice applied', (await glRow('MAGNOLIA CAFE').innerText()).includes('5400 Restaurants'));

  // ---------- drill down from Budget and come back ----------
  await page.click('#tab-budget');
  await page.locator('#where .catrow').first().click();
  check('tapping a category opens GL Detail, filtered', (await onGL()) && /\d+ of 74/.test(await page.textContent('#gl-count')));
  check('there is a Back button', /Back to Budget/.test(await page.textContent('#gl-back')));
  await page.click('#gl-back');
  check('Back returns to Budget', (await page.getAttribute('#tab-budget', 'aria-selected')) === 'true');

  // ---------- tie-out, and a savings move logged by hand ----------
  await page.click('#tab-tie');
  await page.selectOption('#tie-period', '2026-01');
  check('tie-out ties to the checking account', /Ties to your checking/.test(await page.textContent('#tie .check')));
  await page.locator('#tie-savings summary').click();
  await page.selectOption('#mv-direction', 'out'); await page.selectOption('#mv-account', 'save_chase');
  await page.fill('#mv-amount', '150'); await page.fill('#mv-date', '2026-01-20');
  await page.locator('#tie-savings').getByRole('button', { name: 'Add', exact: true }).click();
  check('a $150 pull from savings shows on the tie-out', /\$150/.test(await page.textContent('#tie-savings')) && /Pulled out/.test(await page.textContent('#tie-savings')));
  check('and the tie-out still ties', /Ties to your checking/.test(await page.textContent('#tie .check')));
  await goFS('tb');
  check('the trial balance still balances after it', /Every month balances/.test(await page.locator('#fs-tb .mx-legend').textContent()));
  await saved();

  // ---------- encrypted at rest ----------
  const stored = await envelopeText();
  check('stored data is unreadable', !/WHOLEFDS|MAGNOLIA|AUSTIN|Lisbon|5455/i.test(stored) && stored.includes('"app":"my-budget"'), `(${stored.length} bytes)`);

  // ---------- reload -> locked ----------
  await page.reload();
  await page.waitForSelector('#lock:not([hidden])');
  check('locked after reload, nothing visible', await page.locator('#app').isHidden() && !(await body()).includes('WHOLEFDS'));
  await page.fill('#lock-pass', 'wrong passphrase'); await page.click('#lock-btn');
  await page.waitForFunction(() => /Wrong passphrase/.test(document.getElementById('lock-msg').textContent), null, { timeout: 15000 });
  check('wrong passphrase rejected', await page.locator('#lock').isVisible());
  await page.fill('#lock-pass', PASS); await page.click('#lock-btn');
  await page.waitForSelector('#panel-budget:not([hidden]) #bgt-summary .hero-num', { timeout: 15000 });
  await goFS('gl');
  check('unlock restores every transaction, including the one logged by hand', (await txCount()) === n + 1);
  check('the hand-logged move survived and is marked', (await glRow('BY HAND').textContent()).includes('entered by hand'));
  await glRow('BY HAND').locator('text=Remove').click();
  check('removing it takes it out of the books', (await txCount()) === n);
  await saved();
  check('category choice survived', (await glRow('MAGNOLIA CAFE').innerText()).includes('5400 Restaurants'));
  check('trip survived', (await glRow('DELTA AIR LINES').innerText()).includes('7120 Lisbon'));
  check('TB coding survived', (await glRow('WHOLEFDS').innerText()).includes('5455 Groceries'));
  await page.click('#tab-budget'); await page.click('#plan-details summary');
  await goFS('tb');
  check('opening balances survived', (await cells('Chase Savings'))[1] === '5,000');
  await page.click('#tab-budget');
  check('plan survived', (await page.inputValue('#plan-income')) === '5000' && (await page.inputValue('#plan-save_chase')) === '500');

  // ---------- dummy numbers ----------
  const REAL = ['MAGNOLIA', 'OAKVIEW', 'CITY OF AUSTIN'];
  const leaks = async () => { const t = await body(); return REAL.filter(m => t.includes(m)); };
  check('real data is on screen before dummy mode', (await leaks()).length > 0, '(MAGNOLIA etc. live in the GL tab)');
  const storedBeforeDemo = await envelopeText();
  await gear();
  await page.click('#demo-switch');
  await page.waitForFunction(() => document.getElementById('savechip').textContent === 'Dummy numbers on', null, { timeout: 15000 });
  await closeSheet();
  await goFS('gl');
  const demoText = await body();
  check('dummy mode shows made-up numbers instead', demoText.includes('HARBOR PROPERTY MANAGEMENT') && (await leaks()).length === 0, `(real markers leaked: ${(await leaks()).join(',') || 'none'})`);
  check('adding statements is off while dummy numbers show', await page.locator('#add-btn').isHidden());
  const storedDuringDemo = await envelopeText();
  check('your saved data is untouched during dummy mode', storedDuringDemo === storedBeforeDemo);
  await page.click('#tab-budget'); await page.fill('#plan-income', '9999'); await page.press('#plan-income', 'Tab');
  await page.waitForTimeout(700);
  check('edits made on dummy numbers are never saved', (await envelopeText()) === storedBeforeDemo);
  await gear('Saving & backup');
  check('backup controls are locked away in dummy mode', /locked away/.test(await page.textContent('#settings-body')) && (await page.locator('#settings-body button', { hasText: 'Download' }).count()) === 0);
  await closeSheet();

  await page.reload();
  await page.waitForSelector('#app:not([hidden])');
  check('dummy mode survives a reload with no passphrase prompt', await page.locator('#lock').isHidden() && (await chip()) === 'Dummy numbers on' && (await leaks()).length === 0);

  await gear();
  await page.click('#demo-switch');
  await page.waitForSelector('#demo-pass');
  check('turning dummy numbers off asks for the passphrase', true);
  await page.fill('#demo-pass', 'not it'); await page.click('text=Show my data');
  await page.waitForFunction(() => /Wrong passphrase/.test(document.querySelector('#settings-body .msg').textContent), null, { timeout: 15000 });
  check('wrong passphrase keeps dummy numbers on', (await chip()) === 'Dummy numbers on' && (await leaks()).length === 0);
  await page.fill('#demo-pass', PASS); await page.click('text=Show my data');
  await page.waitForFunction(() => document.getElementById('savechip').textContent === 'Saved on this device', null, { timeout: 15000 });
  await closeSheet();
  await goFS('gl');
  check('your own data is back, exactly as it was', (await txCount()) === n && (await glRow('MAGNOLIA CAFE').innerText()).includes('5400 Restaurants'));
  check('and the plan edit made on dummy numbers is gone', true && (await (async () => { await page.click('#tab-budget'); return (await page.inputValue('#plan-income')) === '5000'; })()));

  // ---------- backup, erase, restore ----------
  await gear('Saving & backup');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('text=Download encrypted backup')]);
  const file = path.join(os.tmpdir(), 'my-budget-e2e-backup.json');
  await download.saveAs(file);
  const backupText = fs.readFileSync(file, 'utf8');
  check('backup file is encrypted', !/WHOLEFDS|MAGNOLIA|Lisbon/i.test(backupText) && JSON.parse(backupText).app === 'my-budget', `(${download.suggestedFilename()})`);

  await page.locator('#settings-body').getByText('Erase everything on this device').click();
  await page.locator('#settings-body').getByText('Tap again to erase everything').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('erased'));
  check('erase empties the device', (await envelopeText()) === null);
  await closeSheet();
  await page.reload();
  check('after erase the app opens empty (no lock screen)', await page.locator('#empty').isVisible() && await page.locator('#lock').isHidden());
  await page.click('#empty-settings');
  await page.locator('details.fine summary', { hasText: 'Restore from a backup file' }).click();
  await page.setInputFiles('#restore-file', file);
  const sec = page.locator('#settings-body');
  await page.fill('#restore-pass', 'not the passphrase');
  await sec.getByRole('button', { name: 'Restore', exact: true }).click();
  await sec.getByRole('button', { name: 'Tap again to restore' }).click();
  await page.waitForFunction(() => /Wrong passphrase/.test(document.getElementById('sec-msg').textContent), null, { timeout: 15000 });
  check('restore with the wrong passphrase is refused', true);
  await page.fill('#restore-pass', PASS);
  await sec.getByRole('button', { name: 'Restore', exact: true }).click();
  await sec.getByRole('button', { name: 'Tap again to restore' }).click();
  await saved();
  await closeSheet();
  await goFS('gl');
  check('restore brings everything back', (await txCount()) === n && (await glRow('DELTA AIR LINES').innerText()).includes('7120 Lisbon') && (await glRow('WHOLEFDS').innerText()).includes('5455 Groceries'));

  // ---------- lock now ----------
  await gear('Saving & backup');
  await page.click('text=Lock now');
  await page.waitForSelector('#lock:not([hidden])');
  check('lock now hides and clears everything', !(await body()).includes('WHOLEFDS') && await page.locator('#app').isHidden());
  await page.fill('#lock-pass', PASS); await page.click('#lock-btn');
  await page.waitForSelector('#panel-budget:not([hidden]) #bgt-summary .hero-num', { timeout: 15000 });
  check('and unlocks again, back on Budget', true);

  check('no console errors or security-policy violations', problems.length === 0, JSON.stringify(problems));
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
});
