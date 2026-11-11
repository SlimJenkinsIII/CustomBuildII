import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatement } from '../app/src/parsers.js';
import { withIds } from '../app/src/ledger.js';
import { matchTransfers } from '../app/src/transfers.js';
import { categorize } from '../app/src/rules.js';
import { buildJournal, totalsOf, trialBalance } from '../app/src/journal.js';
import { SOURCE_ACCOUNTS, SOURCE_ROLES } from '../app/src/categories.js';
import { enrichVenmo, mergeDetails, cleanDetails } from '../app/src/venmodetail.js';

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
  assert.deepEqual({ external: out.notes.external, ignored: out.notes.ignored }, { external: 1, ignored: 2 });   // one funded by the bank, two pending or cancelled
  assert.deepEqual(out.notes.details, [{ date: '2026-03-05', cents: -6000, party: 'Riley Demo', note: 'Concert tickets' }]);   // kept only to say who and why
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

const D = (date, cents, party, note) => ({ date, cents, party, note });
const bankLine = (date, cents, description, id = date + description) => ({ id, account: 'chase-checking', date, cents, description });

test('a bare VENMO PAYMENT on the bank statement is reworded with who you paid and why, once, by amount and nearby date', () => {
  const txs = [bankLine('2026-03-06', -6000, 'VENMO PAYMENT 1053903953802 WEB ID: 3264681992'), bankLine('2026-03-06', -6000, 'WHOLEFDS MKT #1')];
  const out = enrichVenmo(txs, [D('2026-03-05', -6000, 'Riley Demo', 'Concert tickets')]);
  assert.equal(out[0].description, 'TO RILEY DEMO: Concert tickets');
  assert.equal(out[0].bankDescription, 'VENMO PAYMENT 1053903953802 WEB ID: 3264681992');   // the original wording is kept
  assert.equal(out[0].id, txs[0].id);                                                         // same id: your choices on it stay attached
  assert.equal(out[1].description, 'WHOLEFDS MKT #1');                                        // nothing else is touched
});

test('each Venmo detail is used once, the closest date wins, and far-off or different amounts are not matched', () => {
  const txs = [bankLine('2026-03-04', -2500, 'VENMO PAYMENT 1', 'a'), bankLine('2026-03-09', -2500, 'VENMO PAYMENT 2', 'b'), bankLine('2026-03-05', -2600, 'VENMO PAYMENT 3', 'c')];
  const out = enrichVenmo(txs, [D('2026-03-08', -2500, 'Sam Sample', 'Rent'), D('2026-03-20', -2500, 'Far Away', 'Too late')]);
  assert.equal(out.find(t => t.id === 'b').description, 'TO SAM SAMPLE: Rent');             // March 8 is closer to March 9 than to March 4
  assert.equal(out.find(t => t.id === 'a').description, 'VENMO PAYMENT 1');
  assert.equal(out.find(t => t.id === 'c').description, 'VENMO PAYMENT 3');                 // different amount
  assert.equal(enrichVenmo(txs, []), txs);
});

test('a line you entered by hand, or on the Venmo account itself, is never reworded', () => {
  const txs = [{ ...bankLine('2026-03-05', -6000, 'VENMO PAYMENT 9'), byHand: true }, { ...bankLine('2026-03-05', -6000, 'VENMO CASHOUT'), account: 'venmo' }];
  assert.deepEqual(enrichVenmo(txs, [D('2026-03-05', -6000, 'A B', 'x')]), txs);
});

test('details are merged without repeats, and nonsense in saved data is dropped', () => {
  const a = D('2026-03-05', -6000, 'Riley Demo', 'Concert tickets');
  assert.equal(mergeDetails([a], [{ ...a }, D('2026-03-06', -100, 'X Y', '')]).length, 2);
  assert.deepEqual(cleanDetails([a, { date: 'bad', cents: -1, party: 'x', note: '' }, { date: '2026-01-01', cents: 5, party: 'x', note: '' }, 7]), [a]);
  assert.deepEqual(cleanDetails(null), []);
});

test('the reworded line can then be sorted by who it went to, and a friend\'s name is not a transfer word', () => {
  const rows = categorize(matchTransfers(enrichVenmo(withIds([bankLine('2026-03-06', -6000, 'VENMO PAYMENT 1053903953802 WEB ID: 3264681992')]), [D('2026-03-05', -6000, 'Riley Demo', 'Concert tickets')])));
  assert.equal(rows[0].description, 'TO RILEY DEMO: Concert tickets');
  assert.equal(rows[0].category, 'review');
  assert.ok(!rows[0].transfer);
});
