import test from 'node:test';
import assert from 'node:assert/strict';
import { matchTransfers } from '../app/src/transfers.js';
import { categorize } from '../app/src/rules.js';
import { venmo } from '../app/src/parsers.js';
import { withIds, mergeIntoAccount } from '../app/src/ledger.js';

const t = (id, account, date, cents, description, extra = {}) => ({ id, account, date, cents, description, ...extra });

test('money added to Venmo from checking pairs up, even when the Venmo line reads as money from a person', () => {
  const out = matchTransfers([t('o', 'chase-checking', '2026-02-03', -20000, 'VENMO ADDFUNDS'), t('i', 'venmo', '2026-02-04', 20000, 'FROM ME')]);
  assert.deepEqual(out.map(x => x.transfer), ['matched', 'matched']);
});

test('a Venmo payment funded from checking is not taken for adding money', () => {
  const out = matchTransfers([t('o', 'chase-checking', '2026-02-03', -2500, 'VENMO PAYMENT 1234567890'), t('i', 'venmo', '2026-02-03', 2500, 'FROM PAT: dinner')]);
  assert.ok(out.every(x => x.transfer !== 'matched'));
});

test('an instant cash-out pairs with the smaller bank deposit, and the difference is booked as Venmo’s fee', () => {
  const out = matchTransfers([t('o', 'venmo', '2026-03-10', -10000, 'VENMO TRANSFER TO BANK'), t('i', 'chase-checking', '2026-03-10', 9825, 'VENMO CASHOUT')]);
  const cash = out.find(x => x.id === 'o'), fee = out.find(x => x.feeOf === 'o');
  assert.equal(cash.transfer, 'matched'); assert.equal(cash.cents, -9825);
  assert.equal(fee.cents, -175);
  assert.equal(categorize(out).find(x => x.feeOf).category, 'other_misc');
  // a gap too big to be a fee is not paired
  assert.ok(matchTransfers([t('o', 'venmo', '2026-03-10', -10000, 'VENMO TRANSFER TO BANK'), t('i', 'chase-checking', '2026-03-10', 9000, 'VENMO CASHOUT')]).every(x => x.transfer !== 'matched'));
});

test('the Venmo file labels money moved either way, and re-reading an older import does not add it twice', () => {
  const row = (type, amount, extra = {}) => ({ ID: '1', Datetime: '2026-02-04T10:00:00', Type: type, Status: 'Complete', Note: '', From: 'Me', To: '', 'Amount (total)': amount, 'Funding Source': 'Chase Checking', Destination: '', ...extra });
  const v = venmo([row('Add Funds', '+ $200.00'), row('Standard Transfer', '- $50.00', { Destination: 'Chase', 'Funding Source': '' })], 'venmo').transactions;
  assert.deepEqual(v.map(x => x.description), ['VENMO TRANSFER FROM BANK (Chase Checking)', 'VENMO TRANSFER TO BANK (Chase)']);
  const old = withIds([{ account: 'venmo', date: '2026-02-04', cents: 20000, description: 'FROM ME', source: 'venmo' }]);
  const r = mergeIntoAccount(old, withIds(v.slice(0, 1)), 'venmo', 'venmo');
  assert.equal(r.addedCount, 0); assert.equal(r.renamedCount, 1);
  assert.equal(r.merged[0].description, 'VENMO TRANSFER FROM BANK (Chase Checking)');
  assert.equal(r.merged[0].id, old[0].id);                                   // same line, same id: your coding on it stays
});

test('a Venmo line on checking that finds no partner is still a Venmo move, never left for review', async () => {
  const { bridgeVenmo } = await import('../app/src/venmodetail.js');
  const lines = [t('p', 'chase-checking', '2026-04-02', -4500, 'VENMO PAYMENT 1098877'), t('c', 'chase-checking', '2026-04-03', 12000, 'VENMO CASHOUT PPD')];
  const out = categorize(bridgeVenmo(matchTransfers(lines)));
  assert.equal(out.find(x => x.id === 'p').category, 'transfer');                         // checking -> Venmo
  assert.equal(out.find(x => x.fromBankLine === 'p').category, 'transfer');                // arriving in Venmo
  const paid = out.find(x => x.fromBank === 'p');
  assert.deepEqual([paid.account, paid.cents, paid.category], ['venmo', -4500, 'review']); // and paid out of Venmo: the spending to sort
  assert.equal(out.find(x => x.id === 'c').category, 'transfer');                         // Venmo -> checking
  // a pair that already matched is left alone
  const both = categorize(bridgeVenmo(matchTransfers([t('o', 'venmo', '2026-04-05', -5000, 'VENMO TRANSFER TO BANK'), t('i', 'chase-checking', '2026-04-06', 5000, 'VENMO CASHOUT')])));
  assert.equal(both.length, 2); assert.ok(both.every(x => x.transfer === 'matched' && x.category === 'transfer'));
});
