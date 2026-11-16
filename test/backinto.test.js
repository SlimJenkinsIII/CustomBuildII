import test from 'node:test';
import assert from 'node:assert/strict';
import { endOfDayBalances, deriveOpening, mergeAnchors, cleanAnchors, dayBefore } from '../app/src/balances.js';
import { parseStatement } from '../app/src/parsers.js';

// 1000.00 on Dec 31, then +200 and -50 on Jan 5 (same day), -30 on Jan 9
const lines = [{ date: '2026-01-05', cents: 20000, bal: 120000 }, { date: '2026-01-05', cents: -5000, bal: 115000 }, { date: '2026-01-09', cents: -3000, bal: 112000 }];

test('closing balance of each day is found whichever way the file is ordered', () => {
  const want = [{ date: '2026-01-05', cents: 115000 }, { date: '2026-01-09', cents: 112000 }];
  assert.deepEqual(endOfDayBalances(lines), want);                       // oldest first
  assert.deepEqual(endOfDayBalances([...lines].reverse()), want);        // newest first
  assert.deepEqual(endOfDayBalances([{ date: '2026-01-05', cents: 1, bal: NaN }]), []);
});

test('the opening balance is the balance on a day less what moved since', () => {
  const txs = lines.map(l => ({ account: 'a', date: l.date, cents: l.cents }));
  const out = deriveOpening(txs, endOfDayBalances(lines).map(a => ({ account: 'a', ...a, kind: 'file' })), '2025-12-31', { a: 'asset' });
  assert.equal(out.a.cents, 100000);
  assert.ok(out.a.checks.every(c => c.ok));
});

test('a missing transaction shows up as a balance that does not agree', () => {
  const txs = [{ account: 'a', date: '2026-01-05', cents: 20000 }, { account: 'a', date: '2026-01-05', cents: -5000 }];   // Jan 9 line is missing
  const out = deriveOpening(txs, endOfDayBalances(lines).map(a => ({ account: 'a', ...a, kind: 'file' })), '2025-12-31', { a: 'asset' });
  assert.equal(out.a.cents, 100000);
  assert.deepEqual(out.a.checks.map(c => [c.date, c.ok, c.off]), [['2026-01-09', false, -3000]]);
});

test('on a card, a balance you know and the purchases since give what you owed at the start', () => {
  // owed 500.00 on Jan 20; a 100.00 purchase (negative) and a 40.00 payment (positive) happened in between
  const txs = [{ account: 'c', date: '2026-01-10', cents: -10000 }, { account: 'c', date: '2026-01-15', cents: 4000 }];
  const out = deriveOpening(txs, [{ account: 'c', date: '2026-01-20', cents: 50000, kind: 'entered' }], '2025-12-31', { c: 'liability' });
  assert.equal(out.c.cents, 44000);
});

test('a balance you typed is trusted over the ones in the files, and is not overwritten by a file', () => {
  const kept = mergeAnchors([{ account: 'a', date: '2026-01-09', cents: 5, kind: 'entered' }], [{ account: 'a', date: '2026-01-09', cents: 9, kind: 'file' }]);
  assert.deepEqual(kept.map(a => a.cents), [5]);
  assert.deepEqual(cleanAnchors([{ account: 'a', date: 'x', cents: 1 }, { account: 'a', date: '2026-01-01', cents: 1.5 }, { account: 'a', date: '2026-01-01', cents: 2 }]).length, 1);
  assert.equal(dayBefore('2026-03-01'), '2026-02-28');
});

test('a Chase bank file and a Venmo file hand back their balances', () => {
  const chase = 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\nDEBIT,01/09/2026,"X",-30.00,DEBIT,1120.00,\nDEBIT,01/05/2026,"Y",-50.00,DEBIT,1150.00,\nCREDIT,01/05/2026,"Z",200.00,CREDIT,1200.00,\n';
  assert.deepEqual(parseStatement(chase, 'k').anchors, [{ account: 'k', date: '2026-01-05', cents: 115000, kind: 'file' }, { account: 'k', date: '2026-01-09', cents: 112000, kind: 'file' }]);
  const venmo = ['Account Statement', 'Account Activity', ',ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (tax),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer',
    ',,,,,,,,,,,,,,,,$20.00,,,,,', ',1,2026-03-02T18:21:03,Payment,Complete,x,A,B,+ $32.50,,,,0,,Venmo balance,,,,,Venmo,,', ',,,,,,,,,,,,,,,,,"$52.50 ",,$0.00,,'].join('\n');
  assert.deepEqual(parseStatement(venmo, 'v').anchors, [{ account: 'v', date: '2026-03-01', cents: 2000, kind: 'file' }, { account: 'v', date: '2026-03-02', cents: 5250, kind: 'file' }]);
});
