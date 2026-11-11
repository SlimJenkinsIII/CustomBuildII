import test from 'node:test';
import assert from 'node:assert/strict';
import { withIds } from '../app/src/ledger.js';
import { matchTransfers } from '../app/src/transfers.js';
import { categorize, isCardPayment } from '../app/src/rules.js';
import { buildJournal, totalsOf, trialBalance, balanceSheet, tieOut } from '../app/src/journal.js';

const run = rows => categorize(matchTransfers(withIds(rows)));
const tx = (account, date, cents, description) => ({ account, date, cents, description });
const OPEN = { date: '2024-12-31', balances: { 'src:chase-checking': 500000 } };

test('a payment on a card is recognised from the card\'s side, and a card payment from a bank\'s side', () => {
  assert.equal(isCardPayment(tx('amex', '2025-01-05', 30000, 'MOBILE PAYMENT - THANK YOU')), true);
  assert.equal(isCardPayment(tx('chase-card', '2025-01-05', 30000, 'Payment Thank You-Mobile')), true);
  assert.equal(isCardPayment(tx('amex', '2025-01-05', 3000, 'REFUND TRADER JOES')), false);                  // a refund is not a payment
  assert.equal(isCardPayment(tx('chase-checking', '2025-01-05', -30000, 'PAYMENT TO CHASE CARD ENDING IN 4421')), true);
  assert.equal(isCardPayment(tx('chase-checking', '2025-01-05', -30000, 'AMEX EPAYMENT ACH PMT')), true);
  assert.equal(isCardPayment(tx('chase-checking', '2025-01-05', -150000, 'PAYMENT TO OAKVIEW APARTMENTS')), false);   // rent is not a card payment
  assert.equal(isCardPayment(tx('chase-checking', '2025-01-05', -2500, 'VENMO PAYMENT 1234')), false);
});

test('an unmatched card payment files as a transfer, not as something to review', () => {
  const [pay] = run([tx('amex', '2025-01-05', 30000, 'MOBILE PAYMENT - THANK YOU')]);
  assert.equal(pay.transfer, 'unmatched');
  assert.equal(pay.category, 'transfer');
  assert.match(pay.categoryReason, /card payment/);
});

test('when both halves are there they still pair up as before', () => {
  const rows = run([tx('amex', '2025-01-05', 30000, 'MOBILE PAYMENT - THANK YOU'), tx('chase-checking', '2025-01-04', -30000, 'AMEX EPAYMENT ACH PMT')]);
  assert.deepEqual(rows.map(r => r.transfer), ['matched', 'matched']);
  assert.deepEqual(rows.map(r => r.category), ['transfer', 'transfer']);
});

test('things that only look like payments are left for you', () => {
  const rows = run([tx('chase-checking', '2025-01-05', -150000, 'PAYMENT TO OAKVIEW APARTMENTS'), tx('chase-checking', '2025-01-06', -2500, 'VENMO PAYMENT 1234')]);
  assert.ok(rows.every(r => r.category !== 'transfer'));
});

test('an unmatched card payment lowers what you owe and waits in transfers in transit: never an expense or income', () => {
  const rows = run([
    tx('chase-checking', '2025-01-06', 300000, 'ACME CORP PAYROLL'),
    tx('amex', '2025-01-10', -30000, "TRADER JOE'S #123"),
    tx('amex', '2025-01-20', 30000, 'MOBILE PAYMENT - THANK YOU'),            // paid from somewhere that isn't imported
  ]);
  const entries = buildJournal(rows);
  for (const e of entries) { const t = totalsOf([e]); assert.equal(t.debit, t.credit, e.memo); }
  const pay = entries.find(e => e.memo === 'MOBILE PAYMENT - THANK YOU');
  assert.deepEqual(pay.lines, [{ key: 'src:amex', debit: 30000, credit: 0 }, { key: 'clearing', debit: 0, credit: 30000 }]);   // Dr the card, Cr transfers in transit
  const tb = trialBalance(rows, '2025', '', OPEN);
  assert.equal(tb.netIncome.byMonth['2025-01'], 300000 - 30000);              // only the groceries are an expense; the payment is not income
  assert.equal(tb.rows.find(r => r.key === 'review'), undefined);             // and nothing landed in Needs review
  assert.equal(tb.totals.difference['2025-01'], 0);
  const bs = balanceSheet(rows, '2025', '', OPEN);
  assert.equal(bs.difference.byMonth['2025-01'], 0);
  assert.equal(bs.liabilities.byMonth['2025-01'], 0);                           // charged $300, paid $300: owe nothing
  assert.equal(bs.assets.rows.find(r => r.name === 'Transfers in transit').byMonth['2025-01'], -30000);   // the payment came from an account not imported
});

test('the checking tie-out still ties with a card paid from an account that is not imported', () => {
  const rows = run([
    tx('chase-checking', '2025-01-06', 300000, 'ACME CORP PAYROLL'),
    tx('amex', '2025-01-10', -30000, "TRADER JOE'S #123"),
    tx('amex', '2025-01-20', 30000, 'MOBILE PAYMENT - THANK YOU'),
  ]);
  const t = tieOut(rows, { income: 0, planned: {} }, { kind: 'year', year: '2025' }, '', OPEN);
  assert.equal(t.ties, true);
  assert.equal(t.checking, 300000);                                           // checking only moved by the paycheck
});

test('a bank-side card payment with no card statement imported leaves checking, waits in transit, and is no expense', () => {
  const rows = run([
    tx('chase-checking', '2025-01-06', 300000, 'ACME CORP PAYROLL'),
    tx('chase-checking', '2025-01-20', -30000, 'PAYMENT TO CHASE CARD ENDING IN 4421'),
  ]);
  assert.equal(rows[1].category, 'transfer');
  const tb = trialBalance(rows, '2025', '', OPEN);
  assert.equal(tb.netIncome.byMonth['2025-01'], 300000);                      // no expense recorded
  assert.equal(tb.totals.difference['2025-01'], 0);
  const t = tieOut(rows, { income: 0, planned: {} }, { kind: 'year', year: '2025' }, '', OPEN);
  assert.equal(t.ties, true);
});
