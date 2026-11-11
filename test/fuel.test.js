import test from 'node:test';
import assert from 'node:assert/strict';
import { isFuelStop, applyFuelSplit, cleanFuel, DEFAULT_FUEL } from '../app/src/fuel.js';
import { categorize } from '../app/src/rules.js';
import { learnKey } from '../app/src/bulk.js';

const tx = (id, description, cents, category = 'free_transport') => ({ id, date: '2026-03-01', description, cents, category, account: 'amex' });
const FUEL = { on: true, cutoff: 2500, below: 'sub_conv' };

test('gas stations are recognised by name, and ordinary merchants are not', () => {
  for (const d of ['SHELL OIL 57444 AUSTIN TX', 'QT 421 DALLAS', 'WAWA 8123', 'BUC-EE #22', 'CIRCLE K 2723', 'EXXON MOBIL 4411']) assert.equal(isFuelStop(d), true, d);
  for (const d of ['SHELLEYS BAKERY', 'QTRLY FEE', 'WHOLEFDS MKT', 'BPA CONSULTING', 'UBER TRIP']) assert.equal(isFuelStop(d), false, d);
});

test('under the cutoff goes to the convenience account; at or over it stays as gas', () => {
  const out = applyFuelSplit([tx('a', 'SHELL OIL 57444', -850), tx('b', 'SHELL OIL 57444', -2499), tx('c', 'SHELL OIL 57444', -2500), tx('d', 'SHELL OIL 57444', -5200)], FUEL);
  assert.deepEqual(out.map(t => t.category), ['sub_conv', 'sub_conv', 'free_transport', 'free_transport']);   // $25.00 exactly is gas
  assert.match(out[0].categoryReason, /gas station, under \$25/);
});

test('it only touches gas-station charges the app had filed as gas', () => {
  const out = applyFuelSplit([
    tx('a', 'WHOLEFDS MKT', -850, 'free_groceries'),            // not a gas station
    tx('b', 'SHELL OIL 57444', -850, 'review'),                  // not filed as gas: left for you
    tx('c', 'SHELL OIL 57444', 850),                              // money in (a refund) is not a snack
    tx('d', 'UBER TRIP', -850),                                   // filed as gas, but not a gas station
  ], FUEL);
  assert.deepEqual(out.map(t => t.category), ['free_groceries', 'review', 'free_transport', 'free_transport']);
});

test('off means untouched, and it cannot be on with nowhere to send the small charges', () => {
  const txs = [tx('a', 'SHELL OIL 57444', -850)];
  assert.equal(applyFuelSplit(txs, { ...FUEL, on: false }), txs);
  assert.equal(applyFuelSplit(txs, { on: true, cutoff: 2500, below: '' }), txs);
  assert.deepEqual(cleanFuel({ on: true, cutoff: 2500, below: '' }), { ...DEFAULT_FUEL, on: false });
  assert.deepEqual(cleanFuel({ on: true, cutoff: 3000, below: 'sub_conv' }, c => c === 'sub_conv'), { on: true, cutoff: 3000, below: 'sub_conv' });
  assert.deepEqual(cleanFuel({ on: true, cutoff: 3000, below: 'gone' }, c => c === 'sub_conv'), { on: false, cutoff: 3000, below: '' });
  assert.equal(cleanFuel({ cutoff: 5 }).cutoff, 2500);                                                 // nonsense falls back to the default
  assert.deepEqual(cleanFuel(null), DEFAULT_FUEL);
});

test('more chains file as gas by default, so the split sees them', () => {
  const rows = categorize([tx('a', 'QUIKTRIP 123', -4000, undefined), tx('b', 'WAWA 8123', -900, undefined), tx('c', 'SHEETZ 604', -1200, undefined)]);
  assert.deepEqual(rows.map(r => r.category), ['free_transport', 'free_transport', 'free_transport']);
});

test('gas stations are split by amount instead of being remembered whole, so one small purchase never recodes every fill-up', () => {
  assert.equal(learnKey('SHELL OIL 57444 AUSTIN TX'), null);
  assert.equal(learnKey('WAWA 8123'), null);
  assert.equal(learnKey('EL TIEMPO CANTINA'), 'EL TIEMPO');
});
