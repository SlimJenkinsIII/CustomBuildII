import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatement } from '../app/src/parsers.js';
import { withIds } from '../app/src/ledger.js';
import { matchTransfers } from '../app/src/transfers.js';
import { categorize } from '../app/src/rules.js';
import { samplePlan } from '../app/src/plan.sample.js';
import { weeklyRunning } from '../app/src/budget.js';
import { asOfDate, categoryBreakdown, monthPace, topPurchases, diningOut, habits, attention, coverage } from '../app/src/insights.js';

const load = f => withIds(parseStatement(readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8')).transactions);
const sample = () => categorize(matchTransfers([...load('FAKE-chase-checking.csv'), ...load('FAKE-chase-card.csv'), ...load('FAKE-amex.csv')]));
const t = (date, cents, category, extra = {}) => ({ id: date + cents + category, date, cents, category, description: 'x', account: 'a', ...extra });

test('as-of date is the latest transaction', () => assert.equal(asOfDate(sample()), '2026-03-09'));

test('category breakdown: biggest first, shares add to 1, refunds net out', () => {
  const b = categoryBreakdown([t('2026-03-02', -8000, 'free_groceries'), t('2026-03-03', -2000, 'free_coffee'),
    t('2026-03-04', 500, 'free_coffee'), t('2026-04-01', -9999, 'free_gifts')], '2026-03');
  assert.deepEqual(b.rows.map(r => [r.id, r.cents]), [['free_groceries', 8000], ['free_coffee', 1500]]);
  assert.equal(b.total, 9500);
  assert.ok(Math.abs(b.rows.reduce((s, r) => s + r.share, 0) - 1) < 1e-9);
});

test('sample data breakdown includes the unreviewed Venmo money-out', () => {
  const b = categoryBreakdown(sample(), '2026-03');
  assert.equal(b.total, 16682);
  assert.ok(b.rows.some(r => r.id === 'review' && r.cents === 3250));
});

test('weeks are clipped to the days we have data for', () => {
  const rows = weeklyRunning(sample(), samplePlan);
  assert.equal(rows[0].days, 6);       // data starts Mon Mar 2, week began Sun Mar 1
  assert.equal(rows[0].partial, true);
  assert.equal(rows[1].days, 2);       // data ends Mon Mar 9
  assert.equal(rows[0].target, Math.round(6 * 265000 / 31));
});

test('month pace: in-progress month projects, finished month does not', () => {
  const txs = [t('2026-03-05', -30000, 'free_restaurants')];
  const mid = monthPace(txs, samplePlan, '2026-03', '2026-03-10');
  assert.equal(mid.elapsed, 10);
  assert.equal(mid.projected, Math.round(30000 / 10 * 31));
  assert.equal(mid.complete, false);
  const done = monthPace(txs, samplePlan, '2026-03', '2026-04-15');
  assert.equal(done.complete, true);
  assert.equal(done.projected, 30000);
  assert.equal(done.projectedEffect, 265000 - 30000);
});

test('top purchases are the biggest free-cash outflows', () => {
  const top = topPurchases([t('2026-03-02', -500, 'free_coffee'), t('2026-03-03', -9000, 'free_gifts'),
    t('2026-03-04', -50000, 'fixed_rent'), t('2026-03-05', -2000, 'free_shopping')], '2026-03', 2);
  assert.deepEqual(top.map(x => x.cents), [-9000, -2000]);
});

test('dining out adds restaurants, coffee and bars', () => {
  const d = diningOut([t('2026-03-02', -1000, 'free_restaurants'), t('2026-03-03', -500, 'free_coffee'),
    t('2026-03-04', -500, 'free_alcohol'), t('2026-03-05', -8000, 'free_groceries')], '2026-03');
  assert.equal(d.cents, 2000);
  assert.equal(d.share, 0.2);
});

test('habits: counts, current streak, best and worst week', () => {
  const row = (effect, days = 7) => ({ effect, days });
  const h = habits([row(100), row(-50), row(30), row(40), row(999, 1)]);
  assert.equal(h.weeks, 4);            // the 1-day week is too thin to judge
  assert.equal(h.under, 3);
  assert.equal(h.streak, 2);
  assert.equal(h.best.effect, 100);
  assert.equal(h.worst.effect, -50);
});

test('attention: review items, unmatched transfers, reimbursement prompts', () => {
  const a = attention(sample());
  assert.equal(a.review.count, 1);
  assert.equal(a.review.cents, 3250);
  assert.equal(a.unmatched, 1);
  assert.equal(a.reimbursements.length, 0);
});

test('coverage shows each account date range', () => {
  const c = coverage(sample());
  assert.deepEqual(c.map(x => [x.account, x.to]), [['amex', '2026-03-05'], ['chase-card', '2026-03-09'], ['chase-checking', '2026-03-08']]);
});
