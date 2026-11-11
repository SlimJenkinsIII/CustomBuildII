import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatement } from '../app/src/parsers.js';
import { withIds } from '../app/src/ledger.js';
import { matchTransfers } from '../app/src/transfers.js';
import { categorize } from '../app/src/rules.js';
import { buildJournal, totalsOf, trialBalance } from '../app/src/journal.js';
import { SOURCE_ACCOUNTS, SOURCE_ROLES } from '../app/src/categories.js';

const SAMPLE = readFileSync(new URL('../samples/FAKE-venmo.csv', import.meta.url), 'utf8');

test('a Venmo CSV is recognised, title lines and balance rows included', () => {
  const out = parseStatement(SAMPLE);
  assert.equal(out.format, 'venmo');
  assert.ok(out.transactions.every(t => t.account === 'venmo' && t.source === 'venmo'));
});

test('only what moves the Venmo balance is imported', () => {
  const out = parseStatement(SAMPLE);
  const byDesc = Object.fromEntries(out.transactions.map(t => [t.description, t]));
  assert.equal(out.transactions.length, 5);
  assert.equal(byDesc['FROM PAT EXAMPLE: Dinner split'].cents, 3250);              // money in
  assert.equal(byDesc['TO SAM SAMPLE: Rent share'].cents, -45000);                  // paid from the Venmo balance
  assert.equal(byDesc['FROM JORDAN TEST: Utilities'].cents, 8525);                  // a charge someone paid you
  assert.equal(byDesc['VENMO TRANSFER TO BANK (Sample Bank Checking)'].cents, -10000);   // cashed out to the bank
  assert.equal(byDesc['TO CORNER CAFE: Coffee'].cents, -575);
  assert.deepEqual(out.notes, { external: 1, ignored: 2 });                         // one funded by the bank, two pending or cancelled
  assert.ok(!out.transactions.some(t => /Concert/.test(t.description)));            // the bank-funded one is on the bank statement
  assert.ok(!out.transactions.some(t => /Lunch|Gift/.test(t.description)));        // pending and cancelled moved no money
});

test('dates come from the timestamp, and amounts with a plus, a minus, dollar signs and commas are read right', () => {
  const rows = ',ID,Datetime,Type,Status,Note,From,To,Amount (total),Funding Source,Destination\n'
    + ',1,2026-04-01T23:59:59,Payment,Complete,Big one,A B,C D,"- $1,234.56",Venmo balance,\n'
    + ',2,2026-04-02T00:00:01,Payment,Complete,Back,E F,A B,"+ $2,000.00",Venmo balance,\n';
  const out = parseStatement(rows);
  assert.deepEqual(out.transactions.map(t => [t.date, t.cents]), [['2026-04-01', -123456], ['2026-04-02', 200000]]);
});

test('a file that is not Venmo still goes down the old path, and an unknown one is refused in plain words', () => {
  assert.equal(parseStatement('Date,Description,Amount\n03/03/2026,NETFLIX,15.49\n').format, 'amex');
  assert.throws(() => parseStatement('Nothing,Useful\n1,2\n'), /Chase, Amex or Venmo/);
});

test('Venmo is an account you have, like checking, so it balances with everything else', () => {
  assert.equal(SOURCE_ROLES.venmo, 'asset');
  assert.equal(SOURCE_ACCOUNTS.venmo.name, 'Venmo balance');
  const rows = categorize(matchTransfers(withIds(parseStatement(SAMPLE).transactions)));
  for (const e of buildJournal(rows)) { const t = totalsOf([e]); assert.equal(t.debit, t.credit, e.memo); }
  const tb = trialBalance(rows, '2026', '', { date: '2025-12-31', balances: { 'src:venmo': 2000 } });
  assert.equal(tb.totals.difference['2026-03'], 0);
  const venmo = tb.rows.find(r => r.key === 'src:venmo');
  assert.equal(venmo.code, '1030');
  assert.equal(venmo.byMonth['2026-03'], 3250 - 45000 + 8525 - 10000 - 575);       // what moved the balance in March
});

test('a Venmo cash-out pairs with the matching bank deposit as one transfer', () => {
  const bank = { account: 'chase-checking', date: '2026-03-11', cents: 10000, description: 'VENMO CASHOUT 260311' };
  const rows = categorize(matchTransfers(withIds([...parseStatement(SAMPLE).transactions, bank])));
  const cash = rows.filter(r => /TRANSFER TO BANK|CASHOUT/.test(r.description));
  assert.deepEqual(cash.map(r => r.transfer), ['matched', 'matched']);
  assert.deepEqual(cash.map(r => r.category), ['transfer', 'transfer']);
});

test('payments to and from friends are left for you to sort, not filed as transfers', () => {
  const rows = categorize(matchTransfers(withIds(parseStatement(SAMPLE).transactions)));
  const friends = rows.filter(r => /^(FROM|TO) /.test(r.description) && !/CAFE/.test(r.description));
  assert.ok(friends.length === 3 && friends.every(r => r.category === 'review' && !r.transfer));
});

test('a friend paying you on Venmo is never taken for a transfer, even when a bank line has the same amount', () => {
  const venmoIn = { account: 'venmo', date: '2026-03-02', cents: 3250, description: 'FROM PAT EXAMPLE: Dinner split' };
  const bankOut = { account: 'chase-checking', date: '2026-03-03', cents: -3250, description: 'VENMO PAYMENT 1234567890' };
  const rows = categorize(matchTransfers(withIds([venmoIn, bankOut])));
  assert.ok(rows.every(r => r.transfer !== 'matched' && r.category !== 'transfer'));
  const venmoOut = { account: 'venmo', date: '2026-03-02', cents: -4000, description: 'TO SAM SAMPLE: Rent share' };
  const bankIn = { account: 'chase-checking', date: '2026-03-03', cents: 4000, description: 'VENMO CASHOUT' };
  const rows2 = categorize(matchTransfers(withIds([venmoOut, bankIn])));
  assert.ok(rows2.every(r => r.transfer !== 'matched'));                              // a payment to a friend is not a cash-out either
});

test('a cash-out with no deposit imported yet is held as a transfer, not left in review', () => {
  const rows = categorize(matchTransfers(withIds(parseStatement(SAMPLE).transactions)));
  const cash = rows.find(r => /TRANSFER TO BANK/.test(r.description));
  assert.equal(cash.category, 'transfer');
  assert.match(cash.categoryReason, /Venmo cash-out/);
});
