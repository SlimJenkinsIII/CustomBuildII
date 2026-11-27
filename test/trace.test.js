import test from 'node:test';
import assert from 'node:assert/strict';
import { traceCash, deposits } from '../app/src/trace.js';

const ROLES = { chk: 'asset', sav: 'asset', card: 'liability' };
const t = (id, account, date, cents, category, extra = {}) => ({ id, account, date, cents, category, description: id, ...extra });
const adds = r => r.totals.held + r.totals.spent + r.totals.cards + r.totals.transit + r.totals.cardCredit;

// $1,000 in checking at the start; a $5,000 bonus on May 15; spending, a transfer to savings, and a card bill paid
const TXS = [
  t('bonus', 'chk', '2026-05-15', 500000, 'income_bonus'),
  t('dinner', 'chk', '2026-05-16', -20000, 'free_restaurants'),
  t('toSav', 'chk', '2026-05-17', -200000, 'transfer', { transfer: 'matched', pairId: 'inSav' }),
  t('inSav', 'sav', '2026-05-18', 200000, 'transfer', { transfer: 'matched', pairId: 'toSav' }),
  t('flight', 'card', '2026-05-02', -60000, 'vac0_travel'),
  t('shoes', 'card', '2026-05-20', -15000, 'free_shopping'),
  t('payCard', 'chk', '2026-05-25', -75000, 'transfer', { transfer: 'matched', pairId: 'cardPaid' }),
  t('cardPaid', 'card', '2026-05-25', 75000, 'transfer', { transfer: 'matched', pairId: 'payCard' }),
];
const OPEN = { date: '2026-04-30', balances: { 'src:chk': 100000 } };

test('FIFO: the money you had first is spent first, so the bonus goes mostly to savings and the card, and the rest stays', () => {
  const r = traceCash(TXS, { roles: ROLES, opening: OPEN, sources: ['bonus'], method: 'fifo' });
  assert.equal(r.total, 500000);
  assert.equal(adds(r), 500000);                                              // every cent accounted for
  // the $200 dinner and the first $800 of the transfer come from the $1,000 you started with
  assert.equal(r.totals.spent, 0);
  assert.deepEqual(r.moves, [{ from: 'chk', to: 'sav', date: '2026-05-18', cents: 120000 }]);
  assert.deepEqual(r.cards.map(c => [c.charge.id, c.cents]), [['flight', 60000], ['shoes', 15000]]);   // the card bill paid for these
  assert.deepEqual(r.held.sort((a, b) => a.account.localeCompare(b.account)), [{ account: 'chk', cents: 305000 }, { account: 'sav', cents: 120000 }]);
});

test('LIFO: the newest money is spent first, so the bonus paid for the dinner', () => {
  const r = traceCash(TXS, { roles: ROLES, opening: OPEN, sources: ['bonus'], method: 'lifo' });
  assert.equal(adds(r), 500000);
  assert.deepEqual(r.spent.map(s => [s.tx.id, s.cents]), [['dinner', 20000]]);
  assert.equal(r.moves[0].cents, 200000);                                     // all of the transfer to savings was bonus money
  assert.equal(r.totals.cards, 75000);
});

test('a transfer whose other half is not imported shows as in transit', () => {
  const r = traceCash([t('pay', 'chk', '2026-06-01', 100000, 'income_paycheck'), t('out', 'chk', '2026-06-02', -40000, 'transfer')], { roles: ROLES, sources: ['pay'] });
  assert.equal(r.totals.transit, 40000);
  assert.equal(adds(r), 100000);
});

test('the deposits you can follow are money in from outside, newest first, not transfers', () => {
  assert.deepEqual(deposits(TXS, ROLES).map(d => d.id), ['bonus']);
});
