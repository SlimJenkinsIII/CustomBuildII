import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatement } from '../app/src/parsers.js';
import { withIds } from '../app/src/ledger.js';
import { matchTransfers } from '../app/src/transfers.js';
import { categorize } from '../app/src/rules.js';
import { trialBalance, tieOut, openingEntry, openingAccounts, cleanOpening, countBeforeOpening, totalsOf, DEFAULT_OPENING_DATE } from '../app/src/journal.js';

const run = rows => categorize(matchTransfers(withIds(rows)));
const tx = (account, date, cents, description) => ({ account, date, cents, description });
const row = (tb, code) => tb.rows.find(r => r.code === code);

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

test('the opening entry balances; what you have less what you owe goes to opening balance equity', () => {
  const e = openingEntry(OPEN);
  const t = totalsOf([e]);
  assert.equal(t.debit, t.credit);
  assert.deepEqual(e.lines.find(l => l.key === 'equity'), { key: 'equity', debit: 0, credit: 580000 });   // 1,000 + 5,000 - 200
  assert.equal(openingEntry({ date: '2024-12-31', balances: {} }), null);
  const owing = openingEntry({ date: '2024-12-31', balances: { 'src:amex': 20000 } });
  assert.deepEqual(owing.lines.find(l => l.key === 'equity'), { key: 'equity', debit: 20000, credit: 0 });  // owing more than you have
});

test('the books start at the opening balances', () => {
  const tb = trialBalance(YEAR_ONE(), '2025', '', OPEN);
  assert.equal(row(tb, '1000').openBal, 100000);          // checking
  assert.equal(row(tb, '1010').openBal, 500000);          // savings
  assert.equal(row(tb, '2010').openBal, -20000);          // what you owe is a credit
  assert.equal(row(tb, '3000').openBal, -580000);         // opening balance equity
  assert.equal(tb.bal.open.difference, 0);
  assert.equal(tb.openDate, '2024-12-31');
  assert.equal(tb.hasOpening, true);
});

test('each month shows the month-end balance: opening plus everything since', () => {
  const tb = trialBalance(YEAR_ONE(), '2025', '', OPEN);
  const jan = '2025-01', feb = '2025-02';
  assert.equal(row(tb, '1000').balByMonth[jan], 100000 + 300000 - 100000);       // 3,000
  assert.equal(row(tb, '1000').balByMonth[feb], 300000 - 20000 - 50000);         // 2,300
  assert.equal(row(tb, '1010').balByMonth[feb], 550000);                         // savings grew by the transfer
  assert.equal(row(tb, '2010').balByMonth[jan], -50000);                         // owed 200, charged 300
  assert.equal(row(tb, '2010').balByMonth[feb], -30000);                         // paid 200 off
  assert.equal(row(tb, '3000').balByMonth[feb], -580000);                        // equity never moves
});

test('income and spending are year-to-date balances', () => {
  const tb = trialBalance(YEAR_ONE(), '2025', '', OPEN);
  assert.equal(row(tb, '4000').balByMonth['2025-01'], -300000);
  assert.equal(row(tb, '4000').balByMonth['2025-02'], -300000);                  // no new pay in February: still the year's total
  assert.equal(row(tb, '5100').balByMonth['2025-02'], 100000);
  assert.equal(row(tb, '4000').openBal, 0);                                      // the year starts at zero
});

test('every column balances: opening, and each month end', () => {
  const tb = trialBalance(YEAR_ONE(), '2025', '', OPEN);
  assert.equal(tb.bal.open.difference, 0);
  for (const ym of tb.months.filter(m => tb.reached[m])) assert.equal(tb.bal.byMonth[ym].difference, 0, ym);
  const feb = tb.bal.byMonth['2025-02'];
  assert.equal(feb.debit, feb.credit);
  assert.ok(feb.debit > 0);
});

test('months after the data (and before the books) are not shown as balances', () => {
  const tb = trialBalance(YEAR_ONE(), '2025', '', OPEN);
  assert.equal(tb.reached['2025-02'], true);
  assert.equal(tb.reached['2025-03'], false);
  const mid = trialBalance(YEAR_ONE(), '2025', '', { ...OPEN, date: '2025-01-31' });
  assert.equal(mid.reached['2025-01'], true);          // the books start on Jan 31, which is in January
  assert.equal(mid.openDate, '2025-01-31');
});

test('next year: income and spending close into retained earnings, balances carry forward', () => {
  const rows = [...YEAR_ONE(), ...run([tx('chase-checking', '2026-01-05', 300000, 'ACME CORP PAYROLL')])];
  const tb = trialBalance(rows, '2026', '', OPEN);
  assert.equal(tb.openDate, '2025-12-31');
  // 2025: income 3,000 less rent 1,000 and groceries 300 = 1,700 of profit, a credit
  assert.equal(row(tb, '3100').openBal, -170000);
  assert.equal(row(tb, '4000').openBal, 0);                                      // new year, income starts again
  assert.equal(row(tb, '4000').balByMonth['2026-01'], -300000);                  // only 2026 pay
  assert.equal(row(tb, '1000').openBal, 230000);                                 // checking at the end of 2025
  assert.equal(row(tb, '1000').balByMonth['2026-01'], 530000);
  assert.equal(tb.bal.open.difference, 0);
  assert.equal(tb.bal.byMonth['2026-01'].difference, 0);
});

test('anything dated on or before the opening date is before the books and left out', () => {
  const rows = [...YEAR_ONE(), ...run([tx('chase-checking', '2024-12-30', 999999, 'ACME CORP PAYROLL'), tx('chase-checking', '2024-12-31', -5000, 'HEB #404')])];
  assert.equal(countBeforeOpening(rows, OPEN), 2);
  const tb = trialBalance(rows, '2025', '', OPEN);
  assert.equal(row(tb, '1000').balByMonth['2025-01'], 300000);                   // the same as without those rows
  assert.equal(tb.bal.byMonth['2025-01'].difference, 0);
});

test('with no opening balances the balances start from zero, and still balance', () => {
  const tb = trialBalance(YEAR_ONE(), '2025');
  assert.equal(tb.hasOpening, false);
  assert.equal(row(tb, '1000').balByMonth['2025-01'], 200000);
  for (const ym of tb.months.filter(m => tb.reached[m])) assert.equal(tb.bal.byMonth[ym].difference, 0, ym);
});

test('the net income memo follows the year to date', () => {
  const tb = trialBalance(YEAR_ONE(), '2025', '', OPEN);
  assert.equal(tb.netIncomeYtd['2025-01'], 300000 - 100000 - 30000);
  assert.equal(tb.netIncomeYtd['2025-02'], 170000);
});

test('what moved in a month is still available, and ties to the balances', () => {
  const tb = trialBalance(YEAR_ONE(), '2025', '', OPEN);
  const checking = row(tb, '1000');
  assert.equal(checking.byMonth['2025-01'], 200000);
  assert.equal(checking.balByMonth['2025-02'] - checking.balByMonth['2025-01'], checking.byMonth['2025-02']);
  assert.equal(checking.change, checking.balByMonth['2025-02'] - checking.openBal);
});

test('balances tie to the statements: opening plus the statement rows is the month-end balance', () => {
  const FILES = ['FAKE-jan-feb-chase-checking.csv', 'FAKE-chase-checking.csv'];
  const rows = FILES.flatMap(f => withIds(parseStatement(readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8')).transactions));
  const txs = categorize(matchTransfers(rows));
  const opening = { date: '2025-12-31', balances: { 'src:chase-checking': 300000 } };
  const tb = trialBalance(txs, '2026', '', opening);
  for (const [ym, last] of [['2026-01', '2026-01-31'], ['2026-02', '2026-02-28'], ['2026-03', '2026-03-31']]) {
    const expected = 300000 + rows.filter(t => t.account === 'chase-checking' && t.date <= last).reduce((s, t) => s + t.cents, 0);
    assert.equal(row(tb, '1000').balByMonth[ym], expected, ym);
  }
});

test('the tie-out leaves out anything before the books started', () => {
  const rows = [...YEAR_ONE(), ...run([tx('chase-checking', '2024-12-30', 999999, 'ACME CORP PAYROLL')])];
  const t = tieOut(rows, { income: 0, planned: {} }, { kind: 'year', year: '2025' }, '', OPEN);
  assert.equal(t.effect.income, 300000);
  assert.equal(t.ties, true);
});

test('saved openings are cleaned: bad dates, unknown accounts and bad amounts are dropped', () => {
  assert.deepEqual(cleanOpening(null), { date: DEFAULT_OPENING_DATE, balances: {} });
  assert.equal(cleanOpening({ date: 'soon' }).date, DEFAULT_OPENING_DATE);
  assert.equal(cleanOpening({ date: '2025-06-30' }).date, '2025-06-30');
  assert.deepEqual(cleanOpening({ date: '2025-06-30', balances: { 'src:amex': 5000, nope: 100, save_chase: 12.5, 'src:chase-checking': -5, save_amex: 0 } }).balances, { 'src:amex': 5000 });
});

test('the opening balance form lists what you have first, then what you owe', () => {
  const list = openingAccounts();
  assert.deepEqual(list.map(a => a.side), [...list.map(a => a.side)].sort());   // 'asset' sorts before 'liability'
  assert.equal(list[0].key, 'src:chase-checking');
  assert.ok(list.some(a => a.key === 'save_amex'));
  assert.ok(list.filter(a => a.side === 'liability').every(a => a.key.startsWith('src:')));
});
