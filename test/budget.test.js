import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatement } from '../app/src/parsers.js';
import { withIds } from '../app/src/ledger.js';
import { matchTransfers } from '../app/src/transfers.js';
import { categorize } from '../app/src/rules.js';
import { startOfWeek, addDays, daysInMonth, plannedFreeCash, weekSummary, weeklyRunning, monthSummary, validatePlan } from '../app/src/budget.js';
import { samplePlan } from '../app/src/plan.sample.js';

const load = f => withIds(parseStatement(readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8')).transactions);
const sampleTxs = () => categorize(matchTransfers([...load('FAKE-chase-checking.csv'), ...load('FAKE-chase-card.csv'), ...load('FAKE-amex.csv')]));
const t = (date, cents, category) => ({ id: date + cents + category, date, cents, category, description: 'x', account: 'a' });

test('weeks run Sunday to Saturday', () => {
  assert.equal(startOfWeek('2026-03-01'), '2026-03-01'); // a Sunday
  assert.equal(startOfWeek('2026-03-07'), '2026-03-01'); // Saturday
  assert.equal(startOfWeek('2026-03-08'), '2026-03-08'); // next Sunday
  assert.equal(addDays('2026-02-27', 3), '2026-03-02');
  assert.equal(daysInMonth('2026-02'), 28);
  assert.equal(daysInMonth('2028-02'), 29);
});

test('free cash = take-home minus fixed, subscriptions, set-asides and savings', () => {
  assert.equal(plannedFreeCash(samplePlan), 600000 - 200000 - 20000 - 3000 - 2000 - 10000 - 60000 - 20000 - 20000);
  assert.equal(plannedFreeCash(samplePlan), 265000);
});

test('plan validation gives clear errors', () => {
  assert.throws(() => validatePlan({ income: 1, planned: { nope: 5 } }), /unknown category/);
  assert.throws(() => validatePlan({ income: 1, planned: { free_restaurants: 5 } }), /can't be planned directly/);
  assert.throws(() => validatePlan({ income: 10.5, planned: {} }), /whole cents/);
});

test('weekly target and +/- effect on savings (sample data, week of Mar 1)', () => {
  const w = weekSummary(sampleTxs(), samplePlan, '2026-03-01');
  assert.equal(w.target, Math.round(7 * 265000 / 31)); // 59839
  // groceries 8412 + two coffees 900 + gas 4120 + Venmo (unreviewed, counted) 3250
  assert.equal(w.spent, 8412 + 900 + 4120 + 3250);
  assert.equal(w.effect, w.target - w.spent);
  assert.equal(w.needsReviewCount, 1);
});

test('week straddling two months prorates each day by its own month', () => {
  const w = weekSummary([], samplePlan, '2026-03-29'); // Mar 29,30,31 + Apr 1,2,3,4
  assert.equal(w.target, Math.round(3 * 265000 / 31 + 4 * 265000 / 30));
});

test('under-spending adds to savings and overspending subtracts; running total accumulates', () => {
  const txs = [t('2026-03-02', -10000, 'free_restaurants'), t('2026-03-09', -90000, 'free_restaurants')];
  const rows = weeklyRunning(txs, samplePlan);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].effect > 0);
  assert.ok(rows[1].effect < 0);
  assert.equal(rows[1].running, rows[0].effect + rows[1].effect);
});

test('transfers, income and savings never count as free spending', () => {
  const txs = [t('2026-03-02', -50000, 'transfer'), t('2026-03-03', 210000, 'income_paycheck'),
    t('2026-03-04', -20000, 'save_chase'), t('2026-03-05', -1549, 'sub_streaming')];
  assert.equal(weekSummary(txs, samplePlan, '2026-03-01').spent, 0);
});

test('a refund in a free category reduces spending; unreviewed money-in is ignored', () => {
  const txs = [t('2026-03-02', -5000, 'free_shopping'), t('2026-03-03', 2000, 'free_shopping'), t('2026-03-04', 9999, 'review')];
  assert.equal(weekSummary(txs, samplePlan, '2026-03-01').spent, 3000);
});

test('month summary compares plan to actual by group (sample data, March)', () => {
  const m = monthSummary(sampleTxs(), samplePlan, '2026-03');
  assert.equal(m.income.actual, 210000);
  assert.equal(m.subscriptions.actual, 1549);
  assert.equal(m.subscriptions.planned, 5000);
  assert.equal(m.free.actual, 16682);
  assert.equal(m.free.effect, 265000 - 16682);
  assert.equal(m.savings.actual, 0);
});
