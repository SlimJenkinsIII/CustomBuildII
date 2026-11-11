import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatement } from '../app/src/parsers.js';
import { withIds } from '../app/src/ledger.js';
import { matchTransfers, transferSummary } from '../app/src/transfers.js';

const load = f => withIds(parseStatement(readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8')).transactions);
const tx = (account, date, cents, description) => withIds([{ account, date, cents, description }])[0];

test('sample statements: card payments pair up, Venmo is held for review', () => {
  const all = matchTransfers([...load('FAKE-chase-checking.csv'), ...load('FAKE-chase-card.csv'), ...load('FAKE-amex.csv')]);
  const by = d => all.filter(t => t.description.includes(d));
  assert.equal(by('PAYMENT TO AMEX')[0].transfer, 'matched');
  assert.equal(by('ONLINE PAYMENT')[0].transfer, 'matched');
  assert.equal(by('PAYMENT TO CHASE CARD')[0].transfer, 'matched');
  assert.equal(by('PAYMENT THANK YOU')[0].transfer, 'matched');
  assert.equal(by('VENMO')[0].transfer, 'unmatched'); // Venmo not imported yet
  assert.equal(by('WHOLEFDS')[0].transfer, undefined); // groceries stay spending
  assert.deepEqual(transferSummary(all), { matched: 4, suggested: 0, unmatched: 1 });
});

test('pairs are linked to each other', () => {
  const a = tx('checking', '2026-03-05', -45000, 'PAYMENT TO AMEX');
  const b = tx('amex', '2026-03-06', 45000, 'ONLINE PAYMENT');
  const [x, y] = matchTransfers([a, b]);
  assert.equal(x.pairId, b.id);
  assert.equal(y.pairId, a.id);
});

test('same amount but no transfer wording is only suggested, never auto-applied', () => {
  const [x, y] = matchTransfers([tx('checking', '2026-03-05', -150000, 'ACME LANDLORD LLC'), tx('card', '2026-03-05', 150000, 'REFUND STORE')]);
  assert.equal(x.transfer, 'suggested');
  assert.equal(y.transfer, 'suggested');
});

test('dates too far apart do not pair', () => {
  const r = matchTransfers([tx('checking', '2026-03-01', -5000, 'PAYMENT TO AMEX'), tx('amex', '2026-03-20', 5000, 'PAYMENT THANK YOU')]);
  assert.deepEqual(r.map(t => t.transfer), ['unmatched', 'unmatched']);
});

test('same account never pairs with itself', () => {
  const r = matchTransfers([tx('checking', '2026-03-01', -5000, 'TRANSFER'), tx('checking', '2026-03-01', 5000, 'TRANSFER')]);
  assert.deepEqual(r.map(t => t.transfer), ['unmatched', 'unmatched']);
});

test('each transaction pairs only once (two equal payments, two equal receipts)', () => {
  const r = matchTransfers([
    tx('checking', '2026-03-01', -10000, 'PAYMENT TO AMEX'), tx('checking', '2026-03-10', -10000, 'PAYMENT TO AMEX'),
    tx('amex', '2026-03-02', 10000, 'PAYMENT THANK YOU'), tx('amex', '2026-03-11', 10000, 'PAYMENT THANK YOU'),
  ]);
  assert.equal(r[0].pairId, r[2].id);
  assert.equal(r[1].pairId, r[3].id);
});

test('the two halves of a Chase transfer pair by their shared transaction number, even inside one account and days apart', () => {
  const rows = matchTransfers(withIds([
    { account: 'chase-checking', date: '2026-10-19', cents: -20000, description: 'Online Transfer to SAV ...8527 transaction#: 31092522089' },
    { account: 'chase-checking', date: '2026-10-19', cents: 20000, description: 'Online Transfer from CHK ...1044 transaction#: 31092522089' },
    { account: 'chase-checking', date: '2026-10-20', cents: -5000, description: 'Online Transfer to SAV ...8527 transaction#: 31099999999' },
    { account: 'chase-checking', date: '2026-10-25', cents: 5000, description: 'Online Transfer from CHK ...1044 transaction#: 31099999999' },
  ]));
  assert.deepEqual(rows.map(r => r.transfer), ['matched', 'matched', 'matched', 'matched']);
  assert.equal(rows[0].pairId, rows[1].id);
  assert.equal(rows[2].pairId, rows[3].id);                                    // five days apart, still the same transfer
});

test('the same transaction number is not enough on its own: amounts must be equal and opposite, and it must appear exactly twice', () => {
  const wrongAmount = matchTransfers(withIds([
    { account: 'chase-checking', date: '2026-10-19', cents: -20000, description: 'Online Transfer to SAV transaction#: 31092522089' },
    { account: 'chase-checking', date: '2026-10-19', cents: 19000, description: 'Online Transfer from CHK transaction#: 31092522089' },
  ]));
  assert.notEqual(wrongAmount[0].pairId, wrongAmount[1].id);
  const alone = matchTransfers(withIds([{ account: 'chase-checking', date: '2026-10-19', cents: -20000, description: 'Online Transfer to SAV transaction#: 31092522089' }]));
  assert.equal(alone[0].transfer, 'unmatched');                                // one half only: still waiting for the other
});
