import test from 'node:test';
import assert from 'node:assert/strict';
import { merchantKey, filterItems, applyBulk, undoBulk, similarTo, rangeBetween } from '../app/src/bulk.js';

const tx = (id, date, description, category = 'review', cents = -1000) => ({ id, date, description, category, cents });

test('store numbers and places drop out, so one merchant lines up', () => {
  assert.equal(merchantKey('WHOLEFDS MKT #10234 AUSTIN TX'), 'WHOLEFDS MKT');
  assert.equal(merchantKey('WHOLEFDS MKT #88 DALLAS TX'), 'WHOLEFDS MKT');
  assert.equal(merchantKey('TST* BLUE BOTTLE 0042'), 'TST BLUE');
  assert.equal(merchantKey('7-ELEVEN 33071'), 'ELEVEN');
  assert.equal(merchantKey(''), '');
  assert.equal(merchantKey(undefined), '');
});

test('the list shows what still needs sorting by default, newest first, and leaves matched transfers alone', () => {
  const txs = [tx('a', '2026-03-01', 'ZED'), tx('b', '2026-03-05', 'ALPHA'), tx('c', '2026-03-05', 'BETA'), tx('d', '2026-03-06', 'DONE', 'free_groceries'), tx('e', '2026-03-07', 'PAYMENT', 'transfer')];
  assert.deepEqual(filterItems(txs).map(t => t.id), ['b', 'c', 'a']);                      // newest first, then A to Z
  assert.deepEqual(filterItems(txs, { view: 'all' }).map(t => t.id), ['d', 'b', 'c', 'a']);  // transfers never appear
});

test('search takes several words in any order, and a month narrows it', () => {
  const txs = [tx('a', '2026-03-01', 'BLUE BOTTLE COFFEE'), tx('b', '2026-04-01', 'BLUE BOTTLE COFFEE'), tx('c', '2026-03-02', 'COFFEE SHOP')];
  assert.deepEqual(filterItems(txs, { q: 'coffee blue' }).map(t => t.id), ['b', 'a']);
  assert.deepEqual(filterItems(txs, { q: 'coffee', ym: '2026-03' }).map(t => t.id), ['c', 'a']);
  assert.deepEqual(filterItems(txs, { q: '   ' }).length, 3);
});

test('bulk coding sets every picked item, leaves the rest alone, and can be undone exactly', () => {
  const before = { x: 'free_coffee', y: 'free_shopping' };
  const { next, previous } = applyBulk(before, ['x', 'z', 'w'], 'free_groceries');
  assert.deepEqual(next, { x: 'free_groceries', y: 'free_shopping', z: 'free_groceries', w: 'free_groceries' });
  assert.deepEqual(before, { x: 'free_coffee', y: 'free_shopping' });                        // the original is untouched
  assert.deepEqual(undoBulk(next, previous), before);                                        // x goes back, z and w were new and go away
});

test('"let the app decide" removes your choice from the picked items', () => {
  const { next, previous } = applyBulk({ a: 'free_coffee', b: 'free_coffee' }, ['a'], '__auto');
  assert.deepEqual(next, { b: 'free_coffee' });
  assert.deepEqual(undoBulk(next, previous), { a: 'free_coffee', b: 'free_coffee' });
});

test('select the same merchant in one go, and a range with shift', () => {
  const items = [tx('a', '2026-03-03', 'WHOLEFDS MKT #1 AUSTIN'), tx('b', '2026-03-02', 'WHOLEFDS MKT #7 DALLAS'), tx('c', '2026-03-01', 'HEB 404'), tx('d', '2026-02-27', 'WHOLEFDS MKT #9')];
  assert.deepEqual(similarTo(items, 'WHOLEFDS MKT #1 AUSTIN'), ['a', 'b', 'd']);
  assert.deepEqual(similarTo(items, '!!!'), []);
  assert.deepEqual(rangeBetween(['a', 'b', 'c', 'd'], 'd', 'b'), ['b', 'c', 'd']);
  assert.deepEqual(rangeBetween(['a', 'b', 'c', 'd'], 'zzz', 'b'), ['b']);
});
