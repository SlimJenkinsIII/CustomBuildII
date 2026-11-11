import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatement } from '../app/src/parsers.js';
import { withIds } from '../app/src/ledger.js';
import { matchTransfers } from '../app/src/transfers.js';
import { categorize } from '../app/src/rules.js';
import { assignTrips } from '../app/src/trips.js';
import { applyTripNames, applyCoding, setCode } from '../app/src/categories.js';
import { balanceSheet, trialBalance, sectionOf } from '../app/src/journal.js';
import { dummySnapshot } from '../app/src/dummy.js';

const run = rows => categorize(matchTransfers(withIds(rows)));
const tx = (account, date, cents, description) => ({ account, date, cents, description });

// you have $1,000 in checking and $5,000 in savings and owe $200 on the Amex, at the end of 2024
const OPEN = { date: '2024-12-31', balances: { 'src:chase-checking': 100000, save_chase: 500000, 'src:amex': 20000 } };
const YEAR_ONE = () => run([
  tx('chase-checking', '2025-01-06', 300000, 'ACME CORP PAYROLL'),
  tx('chase-checking', '2025-01-15', -100000, 'ACH DEBIT OAKVIEW APARTMENTS'),
  tx('amex', '2025-01-20', -30000, "TRADER JOE'S #123"),
  tx('chase-checking', '2025-02-03', -20000, 'PAYMENT TO AMEX EPAYMENT'),
  tx('amex', '2025-02-03', 20000, 'ONLINE PAYMENT - THANK YOU'),
  tx('chase-checking', '2025-02-10', -50000, 'ONLINE TRANSFER TO SAV ...1234'),
]);
const named = (sec, name) => sec.rows.find(r => r.name === name);

test('accounts are sorted by what they are: things you have, things you owe, equity, income and spending', () => {
  assert.equal(sectionOf('src:chase-checking'), 'asset');
  assert.equal(sectionOf('src:amex'), 'liability');
  assert.equal(sectionOf('src:chase-card'), 'liability');
  assert.equal(sectionOf('save_chase'), 'asset');          // savings are assets, not spending
  assert.equal(sectionOf('review'), 'asset');              // the suspense account
  assert.equal(sectionOf('clearing'), 'asset');
  assert.equal(sectionOf('equity'), 'equity');
  assert.equal(sectionOf('retained'), 'equity');
  assert.equal(sectionOf('free_groceries'), 'pnl');
  assert.equal(sectionOf('income_paycheck'), 'pnl');
  assert.equal(sectionOf('onetime_annual'), 'pnl');
  assert.equal(sectionOf('vac1_travel'), 'pnl');
});

test('the opening column: what you have, what you owe, and the equity that makes it balance', () => {
  const bs = balanceSheet(YEAR_ONE(), '2025', '', OPEN);
  assert.equal(named(bs.assets, 'Chase checking').open, 100000);
  assert.equal(named(bs.assets, 'Chase Savings').open, 500000);
  assert.equal(bs.assets.open, 600000);
  assert.equal(named(bs.liabilities, 'Amex card').open, 20000);          // owed, shown as a positive number
  assert.equal(named(bs.equity, 'Opening balance equity').open, 580000);
  assert.equal(bs.equity.open, 580000);
  assert.equal(bs.liabilitiesAndEquity.open, 600000);
  assert.equal(bs.difference.open, 0);
  assert.equal(bs.openDate, '2024-12-31');
});

test('month-end balances, with this year\'s earnings inside equity', () => {
  const bs = balanceSheet(YEAR_ONE(), '2025', '', OPEN);
  assert.equal(bs.assets.byMonth['2025-01'], 300000 + 500000);            // checking $3,000 and savings $5,000
  assert.equal(bs.assets.byMonth['2025-02'], 230000 + 550000);            // after the card payment and the savings transfer
  assert.equal(bs.liabilities.byMonth['2025-01'], 50000);                 // owed $200, charged $300
  assert.equal(bs.liabilities.byMonth['2025-02'], 30000);
  assert.equal(bs.equity.earnings.byMonth['2025-01'], 300000 - 100000 - 30000);   // income less rent and groceries
  assert.equal(bs.equity.byMonth['2025-01'], 580000 + 170000);
  assert.equal(bs.liabilitiesAndEquity.byMonth['2025-01'], 50000 + 750000);
});

test('assets always equal liabilities plus equity, in every column', () => {
  for (const [txs, opening] of [[YEAR_ONE(), OPEN], [YEAR_ONE(), undefined]]) {
    const bs = balanceSheet(txs, '2025', '', opening);
    assert.equal(bs.difference.open, 0);
    for (const ym of bs.months.filter(m => bs.reached[m])) assert.equal(bs.difference.byMonth[ym], 0, ym);
  }
});

test('it agrees with the trial balance: the same accounts, the same balances', () => {
  const rows = YEAR_ONE();
  const bs = balanceSheet(rows, '2025', '', OPEN), tb = trialBalance(rows, '2025', '', OPEN);
  const checking = tb.rows.find(r => r.name === 'Chase checking');
  assert.equal(named(bs.assets, 'Chase checking').byMonth['2025-02'], checking.balByMonth['2025-02']);
  const amex = tb.rows.find(r => r.name === 'Amex card');
  assert.equal(named(bs.liabilities, 'Amex card').byMonth['2025-02'], -amex.balByMonth['2025-02']);   // a credit balance, shown positive
});

test('next year: last year\'s earnings sit in retained earnings, and this year\'s start again at zero', () => {
  const rows = [...YEAR_ONE(), ...run([tx('chase-checking', '2026-01-05', 300000, 'ACME CORP PAYROLL')])];
  const bs = balanceSheet(rows, '2026', '', OPEN);
  assert.equal(named(bs.equity, 'Retained earnings').open, 170000);
  assert.equal(bs.equity.earnings.open, 0);
  assert.equal(bs.equity.earnings.byMonth['2026-01'], 300000);
  assert.equal(bs.difference.open, 0);
  assert.equal(bs.difference.byMonth['2026-01'], 0);
});

test('months after the data are blank, not repeated', () => {
  const bs = balanceSheet(YEAR_ONE(), '2025', '', OPEN);
  assert.equal(bs.reached['2025-03'], false);
  assert.equal(bs.assets.byMonth['2025-03'], 0);
});

test('renumbering accounts does not move them between sections', () => {
  try {
    applyCoding(setCode({}, 'save_chase', '2999'));                      // a savings account given a "liability" number
    const bs = balanceSheet(YEAR_ONE(), '2025', '', OPEN);
    assert.ok(named(bs.assets, 'Chase Savings'));
    assert.equal(bs.difference.open, 0);
  } finally { applyCoding({}); }
});

test('the dummy numbers make a balance sheet that balances in every month', () => {
  const snap = dummySnapshot(new Date(Date.UTC(2026, 9, 31)));
  applyTripNames(snap.trips);
  const txs = assignTrips(categorize(matchTransfers(snap.raw)), snap.trips);
  const bs = balanceSheet(txs, '2026', '', snap.opening);
  assert.equal(bs.difference.open, 0);
  for (const ym of bs.months.filter(m => bs.reached[m])) assert.equal(bs.difference.byMonth[ym], 0, ym);
  assert.ok(bs.assets.open > 0);
  assert.ok(bs.assets.byMonth['2026-10'] > 0);
});

test('on the sample statements, with no opening balances, it still balances', () => {
  const FILES = ['FAKE-jan-feb-chase-checking.csv', 'FAKE-jan-feb-chase-card.csv', 'FAKE-jan-feb-amex.csv', 'FAKE-chase-checking.csv', 'FAKE-chase-card.csv', 'FAKE-amex.csv'];
  const rows = FILES.flatMap(f => withIds(parseStatement(readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8')).transactions));
  const bs = balanceSheet(categorize(matchTransfers(rows)), '2026');
  for (const ym of bs.months.filter(m => bs.reached[m])) assert.equal(bs.difference.byMonth[ym], 0, ym);
  assert.ok(bs.liabilities.rows.length >= 2);                            // the two cards
});
