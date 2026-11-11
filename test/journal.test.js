import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatement } from '../app/src/parsers.js';
import { withIds } from '../app/src/ledger.js';
import { matchTransfers } from '../app/src/transfers.js';
import { categorize } from '../app/src/rules.js';
import { assignTrips } from '../app/src/trips.js';
import { applyTripNames } from '../app/src/categories.js';
import { buildJournal, totalsOf, trialBalance, tieOut } from '../app/src/journal.js';
import { monthlyMatrix } from '../app/src/insights.js';
import { samplePlan } from '../app/src/plan.sample.js';
import { dummySnapshot } from '../app/src/dummy.js';

const FILES = ['FAKE-jan-feb-chase-checking.csv', 'FAKE-jan-feb-chase-card.csv', 'FAKE-jan-feb-amex.csv', 'FAKE-chase-checking.csv', 'FAKE-chase-card.csv', 'FAKE-amex.csv'];
const load = f => withIds(parseStatement(readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8')).transactions);
const sample = () => categorize(matchTransfers(FILES.flatMap(load)));
const run = rows => categorize(matchTransfers(withIds(rows)));
const tx = (account, date, cents, description) => ({ account, date, cents, description });
const dummy = () => { const s = dummySnapshot(new Date(Date.UTC(2026, 9, 31))); applyTripNames(s.trips); return { txs: assignTrips(categorize(matchTransfers(s.raw)), s.trips), plan: s.plan }; };

test('every entry balances, and so does the whole ledger', () => {
  for (const data of [sample(), dummy().txs]) {
    const entries = buildJournal(data);
    for (const e of entries) {
      const t = totalsOf([e]);
      assert.equal(t.debit, t.credit, `${e.date} ${e.memo}`);
    }
    const all = totalsOf(entries);
    assert.equal(all.debit, all.credit);
    assert.ok(entries.length > 50);
  }
});

test('money in is a debit, money out is a credit, for banks and cards alike', () => {
  const rows = run([tx('chase-checking', '2026-03-06', 210000, 'ACME CORP PAYROLL'), tx('amex', '2026-03-03', -1549, 'NETFLIX.COM')]);
  const [pay, flix] = buildJournal(rows);
  assert.deepEqual(pay.lines, [{ key: 'src:chase-checking', debit: 210000, credit: 0 }, { key: 'income_paycheck', debit: 0, credit: 210000 }]);
  assert.deepEqual(flix.lines, [{ key: 'src:amex', debit: 0, credit: 1549 }, { key: 'sub_streaming', debit: 1549, credit: 0 }]);   // a charge raises what you owe
});

test('a card payment is one entry between the two accounts, with nothing in expenses', () => {
  const rows = run([tx('chase-checking', '2026-03-05', -45000, 'PAYMENT TO AMEX EPAYMENT'), tx('amex', '2026-03-05', 45000, 'ONLINE PAYMENT - THANK YOU')]);
  const entries = buildJournal(rows);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].lines.map(l => [l.key, l.debit, l.credit]).sort(), [['src:amex', 45000, 0], ['src:chase-checking', 0, 45000]]);
});

test('a transfer whose halves land in different months goes through "transfers in transit", so both months balance', () => {
  const rows = run([tx('chase-checking', '2026-03-31', -50000, 'PAYMENT TO AMEX EPAYMENT'), tx('amex', '2026-04-01', 50000, 'ONLINE PAYMENT - THANK YOU')]);
  const tb = trialBalance(rows, '2026');
  for (const ym of ['2026-03', '2026-04']) assert.equal(tb.totals.difference[ym], 0, ym);
  const clearing = tb.rows.find(r => r.name === 'Transfers in transit');
  assert.equal(clearing.byMonth['2026-03'], 50000);
  assert.equal(clearing.byMonth['2026-04'], -50000);
  assert.equal(clearing.total, 0);                                   // it clears
  assert.equal(tb.rows.find(r => r.code === '1000').byMonth['2026-03'], -50000);   // checking moves in March, as on the statement
});

test('a lone transfer row (no other half) is parked in suspense, not lost', () => {
  const rows = run([tx('chase-checking', '2026-03-05', -20000, 'VENMO PAYMENT')]);
  const [e] = buildJournal(rows);
  assert.ok(e.lines.some(l => l.key === 'review' && l.debit === 20000));
});

test('trial balance: accounts in number order, every month and the year in balance', () => {
  const tb = trialBalance(sample(), '2026');
  const codes = tb.rows.map(r => r.code);
  assert.deepEqual(codes, [...codes].sort());
  assert.ok(codes[0] === '1000' && codes.includes('2000') && codes.includes('2010') && codes.includes('4000') && codes.includes('5430'));
  for (const ym of tb.months) assert.equal(tb.totals.difference[ym], 0, ym);
  assert.equal(tb.totals.differenceYtd, 0);
  assert.equal(tb.totals.debitYtd, tb.totals.creditYtd);
  assert.ok(tb.totals.debitYtd > 0);
});

test('trial balance movement equals the statements: bank and card rows sum to their account', () => {
  const txs = sample();
  const tb = trialBalance(txs, '2026');
  for (const [account, code] of [['chase-checking', '1000'], ['chase-card', '2000'], ['amex', '2010']]) {
    const expected = txs.filter(t => t.account === account).reduce((s, t) => s + t.cents, 0);
    assert.equal(tb.rows.find(r => r.code === code).total, expected, account);
  }
});

test('trial balance net income agrees with the income-statement view, month by month', () => {
  const txs = sample();
  const tb = trialBalance(txs, '2026');
  const m = monthlyMatrix(txs, '2026');
  const net = m.lines.find(l => l.kind === 'net' && l.label === 'Net income (loss)');
  for (const ym of m.months.filter(ym => m.hasData[ym])) {
    // Needs review is an expense account, so unsorted items count in net income in both views
    assert.equal(tb.netIncome.byMonth[ym], net.byMonth[ym], ym);
  }
});

test('other years are ignored and months with no activity show nothing', () => {
  const tb = trialBalance(sample(), '2025');
  assert.equal(tb.rows.length, 0);
  const tb26 = trialBalance(sample(), '2026');
  assert.equal(tb26.totals.debit['2026-07'], 0);
});

test('a month still in progress is marked', () => {
  const tb = trialBalance(sample(), '2026', '2026-03-09');
  assert.equal(tb.partialMonth, '2026-03');
  assert.equal(trialBalance(sample(), '2026', '2026-03-31').partialMonth, null);
});

// ---------- tie-out ----------
const scenario = (extra = []) => run([
  tx('chase-checking', '2026-03-01', -100000, 'ACH DEBIT OAKVIEW APARTMENTS'),
  tx('chase-checking', '2026-03-06', 300000, 'ACME CORP PAYROLL'),
  tx('chase-checking', '2026-03-10', -50000, 'ONLINE TRANSFER TO SAV ...1234'),
  tx('amex', '2026-03-08', -170000, "TRADER JOE'S #123"),
  tx('chase-checking', '2026-03-20', -170000, 'PAYMENT TO AMEX EPAYMENT'),
  tx('amex', '2026-03-20', 170000, 'ONLINE PAYMENT - THANK YOU'),
  ...extra,
]);
const PLAN = { income: 300000, planned: { fixed_rent: 100000, save_chase: 50000 } };      // leaves $1,500 free cash
const MARCH = { kind: 'month', ym: '2026-03' };

test('the tie-out explains the change in checking from everything else, and agrees with the statement', () => {
  const t = tieOut(scenario(), PLAN, MARCH, '2026-03-31');
  assert.equal(t.effect.income, 300000);
  assert.equal(t.effect.fixed, -100000);
  assert.equal(t.effect.free, -170000);
  assert.equal(t.netIncome, 30000);
  assert.equal(t.savingsNet, 50000);                                  // moved into savings
  assert.equal(t.float, 0);                                           // the card was paid off
  assert.equal(t.cashChange, -20000);
  assert.equal(t.checking, -20000);
  assert.equal(t.ties, true);
});

test('overspending $200 with nothing pulled from savings: checking absorbs it, and the tie-out says so', () => {
  const t = tieOut(scenario(), PLAN, MARCH, '2026-03-31');
  assert.equal(t.overspend.over, 20000);
  assert.equal(t.overspend.pulledOut, 0);                             // no money left a savings account
  assert.equal(t.overspend.movedLess, 0);
  assert.equal(t.cashChange, -20000);                                 // all of it came out of checking
  const free = t.vsPlan.find(l => l.label === 'Free cash spending');
  assert.equal(free.effect, -20000);
  assert.equal(t.vsPlanTotal, t.cashChange);                          // the plan comparison ties to the same number
});

test('pulling the $200 out of savings shows it leaving that account, and checking is whole again', () => {
  const t = tieOut(scenario([tx('chase-checking', '2026-03-25', 20000, 'ONLINE TRANSFER FROM SAV ...1234')]), PLAN, MARCH, '2026-03-31');
  const chase = t.savings.find(s => s.name === 'Chase Savings');
  assert.equal(chase.movedIn, 50000);
  assert.equal(chase.pulledOut, 20000);
  assert.equal(chase.net, 30000);
  assert.equal(t.overspend.pulledOut, 20000);
  assert.equal(t.overspend.movedLess, 20000);                         // net savings are $200 under plan
  assert.equal(t.cashChange, 0);
  assert.equal(t.ties, true);
});

test('unpaid card charges are shown as cash that has not left yet', () => {
  const rows = run([tx('chase-checking', '2026-03-06', 300000, 'ACME CORP PAYROLL'), tx('amex', '2026-03-08', -170000, "TRADER JOE'S #123")]);
  const t = tieOut(rows, PLAN, MARCH, '2026-03-31');
  assert.equal(t.float, 170000);
  assert.equal(t.cashChange, 300000 - 170000 + 170000);
  assert.equal(t.ties, true);
});

test('it ties in every month and for the year, on both sample and dummy data', () => {
  for (const { txs, plan } of [{ txs: sample(), plan: samplePlan }, dummy()]) {
    const months = [...new Set(txs.map(t => t.date.slice(0, 7)))];
    const asOf = txs.reduce((m, t) => (t.date > m ? t.date : m), '');
    for (const ym of months) {
      const t = tieOut(txs, plan, { kind: 'month', ym }, asOf);
      assert.equal(t.ties, true, `${ym}: ${t.cashChange} vs ${t.checking}`);
      assert.equal(t.vsPlanTotal, t.cashChange, `${ym} plan comparison`);
    }
    for (const year of new Set(months.map(m => m.slice(0, 4)))) {
      const t = tieOut(txs, plan, { kind: 'year', year }, asOf);
      assert.equal(t.ties, true, `${year}`);
      assert.equal(t.vsPlanTotal, t.cashChange, `${year} plan comparison`);
    }
  }
});

test('a month still in progress scales the plan by the days elapsed', () => {
  const t = tieOut(scenario(), PLAN, MARCH, '2026-03-16');            // 16 of 31 days
  assert.ok(Math.abs(t.factor - 16 / 31) < 1e-9);
  assert.equal(t.vsPlan.find(l => l.label === 'Take-home pay').planned, Math.round(300000 * 16 / 31));
  const full = tieOut(scenario(), PLAN, MARCH, '2026-03-31');
  assert.equal(full.factor, 1);
});

test('entries made by hand never pair with a statement row', () => {
  const rows = run([
    { ...tx('chase-checking', '2026-03-25', 20000, 'MANUAL: PULLED FROM CHASE SAVINGS'), byHand: true, source: 'manual' },
    tx('amex', '2026-03-26', -20000, "TRADER JOE'S #123"),
  ]);
  assert.ok(rows.every(t => !t.transfer));
});
