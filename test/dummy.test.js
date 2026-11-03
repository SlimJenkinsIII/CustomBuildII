import test from 'node:test';
import assert from 'node:assert/strict';
import { dummySnapshot, dummyPlan } from '../app/src/dummy.js';
import { matchTransfers, transferSummary } from '../app/src/transfers.js';
import { categorize } from '../app/src/rules.js';
import { assignTrips } from '../app/src/trips.js';
import { applyTripNames } from '../app/src/categories.js';
import { plannedFreeCash, validatePlan, weeklyRunning } from '../app/src/budget.js';
import { asOfDate } from '../app/src/insights.js';
import { cleanOpening, trialBalance } from '../app/src/journal.js';

const TODAY = new Date(Date.UTC(2026, 9, 31));        // 2026-10-31
const run = (today = TODAY) => {
  const snap = dummySnapshot(today);
  applyTripNames(snap.trips);
  const txs = assignTrips(categorize(matchTransfers(snap.raw)), snap.trips);
  return { snap, txs };
};

test('same seed, same numbers', () => {
  assert.deepEqual(dummySnapshot(TODAY).raw, dummySnapshot(TODAY).raw);
});

test('six months of statements ending today, never in the future', () => {
  const { snap } = run();
  const dates = snap.raw.map(r => r.date).sort();
  assert.ok(dates[0] >= '2026-05-01' && dates[0] <= '2026-05-31', dates[0]);
  assert.ok(dates[dates.length - 1] <= '2026-10-31');
  assert.ok(snap.raw.length > 150);
  assert.equal(new Set(snap.raw.map(r => r.id)).size, snap.raw.length);        // every id is unique
});

test('the dates follow today, so the screens always look current', () => {
  const later = run(new Date(Date.UTC(2027, 2, 15)));
  assert.equal(asOfDate(later.txs) <= '2027-03-15', true);
  assert.ok(asOfDate(later.txs) >= '2027-03-01');
  assert.ok(later.snap.raw.every(r => r.date >= '2026-10-01'));
});

test('it looks like a real month: everything is classified and card payments pair up', () => {
  const { txs } = run();
  assert.equal(txs.filter(t => t.category === 'review').length, 0);
  const s = transferSummary(txs);
  assert.ok(s.matched >= 8, `matched ${s.matched}`);
  assert.equal(s.suggested, 0);
  assert.ok(txs.some(t => t.category === 'income_paycheck'));
  assert.ok(txs.some(t => t.category === 'save_chase'));
  assert.ok(txs.some(t => t.category === 'other_interest'));
  assert.ok(txs.some(t => t.category === 'onetime_annual'));
});

test('the flight and lodging land in the sample trip, in its block of accounts', () => {
  const { txs, snap } = run();
  const trip = snap.trips[0];
  assert.equal(trip.slot, 1);
  assert.ok(txs.some(t => t.category === 'vac1_flights'));
  assert.ok(txs.some(t => t.category === 'vac1_lodging'));
  assert.ok(!txs.some(t => t.category.startsWith('vac0_')));
});

test('the plan is valid, leaves free cash, and the weeks show both good and bad', () => {
  validatePlan(dummyPlan);
  assert.ok(plannedFreeCash(dummyPlan) > 0);
  const { txs } = run();
  const rows = weeklyRunning(txs, dummyPlan).filter(r => r.days >= 7);
  assert.ok(rows.some(r => r.effect > 0), 'some weeks under target');
  assert.ok(rows.some(r => r.effect < 0), 'some weeks over target');
});

test('nothing from the real-looking sample statements leaks in', () => {
  const text = JSON.stringify(dummySnapshot(TODAY));
  for (const marker of ['MAGNOLIA', 'OAKVIEW', 'CITY OF AUSTIN']) assert.ok(!text.includes(marker), marker);
});

test('dummy numbers come with opening balances, and the trial balance built on them balances', () => {
  const { snap, txs } = run();
  assert.deepEqual(cleanOpening(snap.opening), snap.opening);                    // well formed, nothing dropped
  assert.ok(Object.keys(snap.opening.balances).length >= 4);
  const tb = trialBalance(txs, '2026', '', snap.opening);
  assert.equal(tb.bal.open.difference, 0);
  for (const ym of tb.months.filter(m => tb.reached[m])) assert.equal(tb.bal.byMonth[ym].difference, 0, ym);
  assert.equal(tb.rows.find(r => r.code === '1000').openBal, snap.opening.balances['src:chase-checking']);
});
