import test from 'node:test';
import assert from 'node:assert/strict';
import { matchTransfers } from '../app/src/transfers.js';
import { categorize, brokerageKind, TRADE } from '../app/src/rules.js';

const t = (id, account, date, cents, description) => ({ id, account, date, cents, description });
const ACCTS = { 'chase-checking': { name: 'Chase Checkings (1044)', last4: '1044', type: 'checking' }, 'investment-3013': { name: 'JPMorgan (3013)', last4: '3013', type: 'investment' } };

test('a brokerage line needs no coding: interest, dividends, fees and money in or out follow from the wording', () => {
  assert.equal(brokerageKind({ description: 'INTEREST ON CASH' })[0], 'other_interest');
  assert.equal(brokerageKind({ description: 'DIVIDEND VTI' })[0], 'other_gains');
  assert.equal(brokerageKind({ description: 'LONG TERM CAP GAIN DISTRIBUTION' })[0], 'other_gains');
  assert.equal(brokerageKind({ description: 'ADR FEE' })[0], 'other_misc');
  assert.equal(brokerageKind({ description: 'ELECTRONIC FUNDS TRANSFER RECEIVED' })[0], 'transfer');
  const out = categorize([t('a', 'investment-3013', '2026-01-31', 310, 'DIVIDEND VTI'), t('b', 'investment-3013', '2026-02-02', 100000, 'ACH IN')], { investmentAccounts: new Set(['investment-3013']) });
  assert.deepEqual(out.map(x => x.category), ['other_gains', 'transfer']);
  assert.ok(TRADE.test('PURCHASE 5 VTI') && TRADE.test('Sale of AAPL') && !TRADE.test('DIVIDEND VTI'));
});

test('money from checking to the brokerage pairs up even when neither line says "transfer"', () => {
  const lines = [t('o', 'chase-checking', '2026-01-05', -100000, 'JPMORGAN CHASE DEBIT'), t('i', 'investment-3013', '2026-01-09', 100000, 'RECEIVED')];
  const without = matchTransfers(lines);
  assert.equal(without[0].transfer, 'suggested');                          // before: only a guess, held for review
  const out = matchTransfers(lines, { accounts: ACCTS });
  assert.deepEqual(out.map(x => [x.transfer, x.pairId]), [['matched', 'i'], ['matched', 'o']]);
});

test('a line that names the other account (its digits or its name) is enough to pair', () => {
  const ACC = { a: { name: 'Chase Checkings (1044)', last4: '1044', type: 'checking' }, b: { name: 'Ally Bank (5555)', last4: '5555', type: 'checking' } };
  const out = matchTransfers([t('o', 'a', '2026-03-01', -2500, 'ONLINE DEBIT ALLY BANK'), t('i', 'b', '2026-03-02', 2500, 'REC FROM ...1044')], { accounts: ACC });
  assert.equal(out[0].transfer, 'matched');
});

test('an investment transfer can take a few more days to land', () => {
  const out = matchTransfers([t('o', 'chase-checking', '2026-01-02', -50000, 'ACH'), t('i', 'investment-3013', '2026-01-09', 50000, 'DEPOSIT')], { accounts: ACCTS });
  assert.equal(out[0].transfer, 'matched');
});
