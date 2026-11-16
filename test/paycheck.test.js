import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPay, payParts, monthlyTakeHome, readPaychecks, monthIncome, savingsByAccount } from '../app/src/paycheck.js';

// made-up numbers: $4,000 gross every two weeks, 10% to the 401(k), 4% match, $2,700 take-home
const PAY = cleanPay({ every: 'biweekly', gross: 400000, takeHome: 270000, pct: 1000, match: 400, limit: 2450000 });
const dep = (date, cents, category = 'income_paycheck') => ({ id: date + cents, date, cents, category, account: 'chase-checking', description: 'ACME PAYROLL' });

test('the paystub you enter is checked, and gives the usual month', () => {
  assert.equal(cleanPay({ every: 'biweekly', gross: 100, takeHome: 200 }), null);           // take-home can't be more than gross
  assert.equal(cleanPay({ every: 'sometimes', gross: 100, takeHome: 50 }), null);
  assert.equal(payParts(PAY).contrib, 40000);
  assert.equal(monthlyTakeHome(PAY), 585000);                                                 // 2,700 x 26 / 12
});

test('an ordinary paycheck is normal, and its 401(k) is counted', () => {
  const r = readPaychecks([dep('2026-01-09', 270000), dep('2026-01-23', 270850)], PAY, '2026');
  assert.deepEqual(r.rows.map(x => x.kind), ['normal', 'normal']);                          // a few dollars off is still normal
  assert.equal(r.totals.contrib, 80000);
  assert.equal(r.totals.match, 32000);
  assert.equal(r.totals.extra, 0);
});

test('a bigger deposit is a normal paycheck plus a bonus, backed into from the take-home rate', () => {
  const r = readPaychecks([dep('2026-03-06', 270000 + 135000)], PAY, '2026');
  const row = r.rows[0];
  assert.equal(row.kind, 'bonus');
  assert.equal(row.extra, 135000);                                                             // the bonus part of the take-home
  // rate = 2,700 / 3,600 = 0.75; bonus gross = 1,350 / 0.75 / 0.9 = 2,000; 10% of it to the 401(k)
  assert.equal(row.grossEst, 600000);
  assert.equal(row.contrib, 60000);
});

test('after the yearly 401(k) limit nothing more goes in, and the bigger paychecks are not taken for bonuses', () => {
  const pay = { ...PAY, limit: 100000 };                                                       // a small limit so it is reached quickly
  const r = readPaychecks([dep('2026-01-09', 270000), dep('2026-01-23', 270000), dep('2026-02-06', 285000), dep('2026-02-20', 300000)], pay, '2026');
  assert.deepEqual(r.rows.map(x => x.kind), ['normal', 'normal', 'capped', 'capped']);
  assert.deepEqual(r.rows.map(x => x.contrib), [40000, 40000, 20000, 0]);
  assert.equal(r.totals.contrib, 100000);
  assert.equal(r.totals.capDate, '2026-02-06');
  assert.equal(r.totals.extra, 0);
});

test('a month shows what came in, the bonus part on its own, and the 401(k) so far this year', () => {
  const m = monthIncome([dep('2026-01-09', 270000), dep('2026-02-06', 270000), dep('2026-02-20', 405000), dep('2026-02-21', 5000, 'income_other')], PAY, '2026-02');
  assert.equal(m.received, 675000);
  assert.equal(m.extra, 135000);
  assert.equal(m.planned, 585000);
  assert.equal(m.contribYtd, 40000 + 40000 + 60000);
  assert.equal(m.paychecks.length, 2);                                                         // the reimbursement is not a paycheck
});

test('savings by account counts what you moved in and out, not interest', () => {
  const txs = [
    { account: 'savings-8527', date: '2026-02-03', cents: 50000, category: 'transfer' },
    { account: 'savings-8527', date: '2026-02-15', cents: -10000, category: 'transfer' },
    { account: 'savings-8527', date: '2026-02-28', cents: 412, category: 'other_interest' },
    { account: 'savings-8527', date: '2026-03-01', cents: 9999, category: 'transfer' }];
  assert.deepEqual(savingsByAccount(txs, { 'src:savings-8527': 50000 }, '2026-02'), [{ key: 'src:savings-8527', planned: 50000, actual: 40000 }]);
});
