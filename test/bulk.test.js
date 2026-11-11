import test from 'node:test';
import assert from 'node:assert/strict';
import { merchantKey, filterItems, applyBulk, undoBulk, similarTo, rangeBetween, learnKey, learn, forget, applyLearned, cleanLearned } from '../app/src/bulk.js';

const tx = (id, date, description, category = 'review', cents = -1000) => ({ id, date, description, category, cents });

test('store numbers and places drop out, so one merchant lines up', () => {
  assert.equal(merchantKey('WHOLEFDS MKT #10234 AUSTIN TX'), 'WHOLEFDS MKT');
  assert.equal(merchantKey('WHOLEFDS MKT #88 DALLAS TX'), 'WHOLEFDS MKT');
  assert.equal(merchantKey('TST* BLUE BOTTLE 0042'), 'BLUE BOTTLE');          // card-processor prefixes are skipped
  assert.equal(merchantKey('SQ *BLUE BOTTLE COFFEE'), 'BLUE BOTTLE');
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

test('vague names are not remembered, and ordinary merchants are', () => {
  assert.equal(learnKey('WHOLEFDS MKT #10234 AUSTIN TX'), 'WHOLEFDS MKT');
  assert.equal(learnKey('EL TIEMPO CANTINA HOUSTON'), 'EL TIEMPO');
  assert.equal(learnKey('HEB #404'), 'HEB');
  assert.equal(learnKey('AMAZON MKTPLACE PMTS'), null);        // covers everything
  assert.equal(learnKey('PAYPAL *SOMEONE'), null);
  assert.equal(learnKey('VENMO PAYMENT 1234'), null);
  assert.equal(learnKey('AB 12'), null);                        // too short to be sure
});

test('coding a charge teaches the app about that merchant, and the last choice is the one kept', () => {
  const items = [tx('a', '2026-03-01', 'EL TIEMPO CANTINA 22', 'review', -4200), tx('b', '2026-03-02', 'EL TIEMPO CANTINA 31', 'review', -5100)];
  const first = learn({}, items, 'free_restaurants');
  assert.deepEqual(first.next, { 'EL TIEMPO': { c: 'free_restaurants', s: 'out' } });
  assert.deepEqual(first.remembered, ['EL TIEMPO']);                         // one merchant, however many charges
  const second = learn(first.next, [items[0]], 'free_entertainment');
  assert.equal(second.next['EL TIEMPO'].c, 'free_entertainment');           // changed your mind: the new choice replaces it
  assert.deepEqual(learn(first.next, items, '__auto').next, {});            // "let the app decide" forgets it
});

test('names that cover everything are skipped and reported, not remembered', () => {
  const out = learn({}, [tx('a', '2026-03-01', 'AMAZON MKTPLACE PMTS'), tx('b', '2026-03-02', 'HEB #404')], 'free_groceries');
  assert.deepEqual(Object.keys(out.next), ['HEB']);
  assert.deepEqual(out.skipped, ['AMAZON MKTPLACE']);
});

test('what was learned files the other charges, past and future, but never transfers, and respects money in versus out', () => {
  const learned = { 'EL TIEMPO': { c: 'free_restaurants', s: 'out' }, 'ACME PAYROLL': { c: 'income_paycheck', s: 'in' } };
  const txs = [
    tx('a', '2026-04-01', 'EL TIEMPO CANTINA 55', 'review', -3800),
    tx('b', '2026-04-02', 'EL TIEMPO REFUND', 'review', 1500),                       // money in: not what was learned
    tx('c', '2026-04-03', 'EL TIEMPO', 'free_coffee', -600),                         // the built-in rule said coffee; your choice outranks it
    { ...tx('d', '2026-04-04', 'EL TIEMPO PAYMENT', 'transfer', -100), transfer: 'matched' },
    tx('e', '2026-04-05', 'ACME PAYROLL 0412', 'review', 300000),
    tx('f', '2026-04-06', 'SOMEONE ELSE', 'review', -100),
  ];
  const out = applyLearned(txs, learned);
  assert.deepEqual(out.map(t => t.category), ['free_restaurants', 'review', 'free_restaurants', 'transfer', 'income_paycheck', 'review']);
  assert.equal(out[0].categoryReason, 'learned from your choices');
  assert.equal(applyLearned(txs, {}), txs);                                          // nothing learned: nothing touched
});

test('an account that no longer exists is ignored rather than trusted', () => {
  const valid = c => c === 'free_restaurants';
  assert.deepEqual(cleanLearned({ 'EL TIEMPO': { c: 'free_restaurants', s: 'out' }, GONE: { c: 'nope' }, BAD: { c: 'free_restaurants', s: 'sideways' }, JUNK: 5 }, valid), { 'EL TIEMPO': { c: 'free_restaurants', s: 'out' } });
  assert.equal(applyLearned([tx('a', '2026-04-01', 'EL TIEMPO', 'review')], { 'EL TIEMPO': { c: 'nope', s: '' } }, valid)[0].category, 'review');
  assert.deepEqual(forget({ A: { c: 'x', s: '' }, B: { c: 'y', s: '' } }, 'A'), { B: { c: 'y', s: '' } });
});
