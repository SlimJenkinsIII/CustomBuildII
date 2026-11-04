import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatement } from '../app/src/parsers.js';
import { withIds } from '../app/src/ledger.js';
import { matchTransfers } from '../app/src/transfers.js';
import { categorize } from '../app/src/rules.js';
import { weeklyRunning, addDays } from '../app/src/budget.js';
import { samplePlan } from '../app/src/plan.sample.js';
import {
  completeWeeks, periodWindow, periodTotals, compareTotals, cumulativeSeries,
  categoryBreakdownRange, categoryBreakdown, staleAccounts, defaultMonth,
} from '../app/src/insights.js';

const FILES = ['FAKE-jan-feb-chase-checking.csv', 'FAKE-jan-feb-chase-card.csv', 'FAKE-jan-feb-amex.csv', 'FAKE-chase-checking.csv', 'FAKE-chase-card.csv', 'FAKE-amex.csv'];
const load = f => withIds(parseStatement(readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8')).transactions);
const sample = () => categorize(matchTransfers(FILES.flatMap(load)));
const t = (date, cents, category, account = 'a') => ({ id: date + cents + category, date, cents, category, description: 'x', account });

// weekly rows like the budget engine produces; each starts on the given Sunday
const week = (weekStart, spent, target = 60000, days = 7) =>
  ({ weekStart, weekEnd: addDays(weekStart, 6), days, partial: days < 7, spent, target, effect: target - spent });
const weeks = (first, spends) => spends.map((s, i) => week(addDays(first, i * 7), s));

test('only full weeks count; partial weeks at either end are set aside', () => {
  const rows = [week('2026-01-01', 1000, 60000, 3), ...weeks('2026-01-04', [50000, 70000]), week('2026-01-18', 100, 60000, 2)];
  assert.deepEqual(completeWeeks(rows).map(r => r.weekStart), ['2026-01-04', '2026-01-11']);
});

test('last N weeks, plus the same number of weeks just before them to compare with', () => {
  const complete = weeks('2026-01-04', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => n * 1000));
  const w = periodWindow(complete, '4w');
  assert.deepEqual(w.rows.map(r => r.spent), [7000, 8000, 9000, 10000]);
  assert.deepEqual(w.prev.map(r => r.spent), [3000, 4000, 5000, 6000]);
  assert.equal(periodWindow(complete, '8w').rows.length, 8);
  assert.equal(periodWindow(complete, '8w').prev.length, 0);        // only 2 weeks before: not enough to compare fairly
  assert.equal(periodWindow(complete, '12w').rows.length, 10);      // fewer weeks than asked for: show what exists
});

test('with too little history there is nothing to compare, and with none there is nothing at all', () => {
  assert.equal(periodWindow(weeks('2026-01-04', [1000, 2000, 3000, 4000, 5000]), '4w').prev.length, 0);
  assert.deepEqual(periodWindow([], '4w'), { rows: [], prev: [] });
  assert.equal(periodTotals([]).weeks, 0);
  assert.equal(periodTotals([]).best, null);
});

test('year to date takes the weeks that start this year', () => {
  const complete = weeks('2025-12-21', [1, 2, 3, 4].map(n => n * 1000));      // Dec 21, Dec 28, Jan 4, Jan 11
  const w = periodWindow(complete, 'ytd');
  assert.deepEqual(w.rows.map(r => r.weekStart), ['2026-01-04', '2026-01-11']);
  assert.equal(w.prev.length, 0);
});

test('totals: spent, target, effect on savings, weeks under and over, best and worst', () => {
  const rows = weeks('2026-01-04', [50000, 70000, 40000, 60000]);               // target 60,000 each
  const p = periodTotals(rows);
  assert.equal(p.weeks, 4);
  assert.equal(p.spent, 220000);
  assert.equal(p.target, 240000);
  assert.equal(p.effect, 20000);                                                // +$200 into savings
  assert.equal(p.under, 3);                                                     // 50k, 40k and exactly 60k count as on target
  assert.equal(p.over, 1);
  assert.equal(p.avgSpent, 55000);
  assert.equal(p.best.weekStart, '2026-01-18');                                 // the $400 week
  assert.equal(p.worst.weekStart, '2026-01-11');                                // the $700 week
  assert.equal(p.from, '2026-01-04');
  assert.equal(p.to, '2026-01-31');                                             // end of the last week
});

test('comparison with the weeks before: spending change and change in the effect on savings', () => {
  const cur = periodTotals(weeks('2026-02-01', [50000, 50000]));
  const before = periodTotals(weeks('2026-01-18', [60000, 60000]));
  const c = compareTotals(cur, before);
  assert.equal(c.spentDelta, -20000);
  assert.ok(Math.abs(c.pct - (-20000 / 120000)) < 1e-9);
  assert.equal(c.effectDelta, 20000);
  assert.equal(compareTotals(cur, null), null);
  assert.equal(compareTotals(cur, periodTotals([])), null);
});

test('running effect on savings, week by week', () => {
  const s = cumulativeSeries(weeks('2026-01-04', [50000, 70000, 40000]));
  assert.deepEqual(s.map(p => p.running), [10000, 0, 20000]);
  assert.equal(s[2].weekStart, '2026-01-18');
});

test('category totals over a date range include both ends and net out refunds', () => {
  const txs = [t('2026-03-01', -1000, 'free_coffee'), t('2026-03-07', -2000, 'free_groceries'), t('2026-03-08', -9999, 'free_groceries'),
    t('2026-02-28', -5000, 'free_coffee'), t('2026-03-03', 500, 'free_coffee'), t('2026-03-04', -99999, 'fixed_rent')];
  const b = categoryBreakdownRange(txs, '2026-03-01', '2026-03-07');
  assert.deepEqual(b.rows.map(r => [r.id, r.cents]), [['free_groceries', 2000], ['free_coffee', 500]]);
  assert.equal(b.total, 2500);
  assert.equal(categoryBreakdown(txs, '2026-03').total, 2000 + 9999 + 500);     // the whole-month version still works
});

test('accounts whose statements stop earlier than the others are flagged', () => {
  const stale = staleAccounts(sample(), 4);
  assert.deepEqual(stale.map(s => [s.account, s.behind]), [['amex', 4]]);       // Amex ends Mar 5, the card Mar 9
  assert.deepEqual(staleAccounts(sample(), 5), []);
  assert.deepEqual(staleAccounts([t('2026-03-01', -100, 'free_coffee', 'only-one')], 4), []);
});

test('the month to review first is the latest finished one', () => {
  assert.equal(defaultMonth(sample()), '2026-02');                              // data ends Mar 9, so March is still going
  assert.equal(defaultMonth([...sample(), t('2026-03-31', -100, 'free_coffee')]), '2026-03');
  assert.equal(defaultMonth([t('2026-03-05', -100, 'free_coffee')]), '2026-03');   // only one month, partial: use it
  assert.equal(defaultMonth([]), null);
});

test('on the sample statements: the last 4 full weeks, compared with the 4 before', () => {
  const complete = completeWeeks(weeklyRunning(sample(), samplePlan));
  assert.ok(complete.every(r => r.days === 7));
  assert.equal(complete[complete.length - 1].weekStart, '2026-03-01');          // the week of Mar 8 is still in progress
  const w = periodWindow(complete, '4w');
  assert.equal(w.rows.length, 4);
  assert.equal(w.prev.length, 4);
  const p = periodTotals(w.rows);
  assert.equal(p.effect, p.target - p.spent);
  assert.equal(p.to, '2026-03-07');
  assert.ok(p.under + p.over === 4);
});
