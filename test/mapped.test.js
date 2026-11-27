import test from 'node:test';
import assert from 'node:assert/strict';
import { findHeader, headerKey, flexDate, parseMapped, cleanFormats, parseStatement } from '../app/src/parsers.js';

// made-up brokerage export: account details first, then the columns; money in and out in separate columns; buys and sells inside
const BROKER = ['Account: Individual ...3013', 'As of 11/27/2026', '',
  'Trade Date,Description,Type,Amount In,Amount Out,Cash Balance',
  '01/05/2026,TRANSFER FROM CHASE CHECKING,Deposit,"1,000.00",,"1,000.00"',
  '01/06/2026,BOUGHT 5 VTI,Buy,,900.00,100.00',
  '01/31/2026,DIVIDEND VTI,Dividend,3.10,,103.10',
  '02/02/2026,WITHDRAWAL TO CHASE,Withdrawal,,50.00,53.10'].join('\n');

test('the column names are found below lines of account details', () => {
  const f = findHeader(BROKER);
  assert.deepEqual(f.headers, ['Trade Date', 'Description', 'Type', 'Amount In', 'Amount Out', 'Cash Balance']);
  assert.equal(f.rows.length, 4);
  assert.equal(headerKey(f.headers), 'trade date|description|type|amount in|amount out|cash balance');
});

test('dates are read in the usual ways', () => {
  assert.equal(flexDate('01/05/2026'), '2026-01-05');
  assert.equal(flexDate('1/5/26'), '2026-01-05');
  assert.equal(flexDate('2026-01-05T10:22:00Z'), '2026-01-05');
  assert.equal(flexDate('Jan 5, 2026'), '2026-01-05');
  assert.equal(flexDate('05 Jan 2026'), '2026-01-05');
  assert.equal(flexDate('soon'), null);
});

test('a brokerage file is read with in and out columns, buys and sells left out, balances kept', () => {
  const r = parseMapped(BROKER, { date: 'Trade Date', description: 'Description', credit: 'Amount In', debit: 'Amount Out', balance: 'Cash Balance', skip: ['buy', 'bought', 'sell', 'sold'] }, 'investment-3013');
  assert.deepEqual(r.transactions.map(t => [t.date, t.cents]), [['2026-01-05', 100000], ['2026-01-31', 310], ['2026-02-02', -5000]]);
  assert.equal(r.skipped, 1);
  assert.equal(r.anchors.length, 0);                                     // a cash balance can't check the account once buys are left out
  const plain = parseMapped(BROKER, { date: 'Trade Date', description: 'Description', credit: 'Amount In', debit: 'Amount Out', balance: 'Cash Balance' }, 'savings-1');
  assert.deepEqual(plain.anchors.map(a => a.cents), [100000, 10000, 10310, 5310]);   // without leaving anything out, each day's balance is kept
});

test('a file that shows money out as positive is flipped', () => {
  const t = 'Date,Description,Amount\n03/01/2026,INTEREST,-1.25\n03/02/2026,TRANSFER IN,-500.00\n03/05/2026,TRANSFER OUT,200.00';
  const r = parseMapped(t, { date: 'Date', description: 'Description', amount: 'Amount', outIsPositive: true }, 'savings-6348');
  assert.deepEqual(r.transactions.map(x => x.cents), [125, 50000, -20000]);
});

test('an unknown file says so, so the app can ask which column is which', () => {
  assert.throws(() => parseStatement('Posted,Memo,Value\n01/01/2026,X,1.00'), e => e.unknown === true);
  // a known kind of file with account details above its columns is still recognised
  const chase = 'Account ...1044\n\nDetails,Posting Date,Description,Amount,Type,Balance,Check or Slip #\nDEBIT,01/09/2026,"X",-30.00,DEBIT,1120.00,\n';
  assert.equal(parseStatement(chase, 'k').transactions.length, 1);
});

test('saved layouts are checked', () => {
  assert.equal(cleanFormats([{ key: 'a', date: 'Date' }]).length, 0);                       // no amount column
  assert.equal(cleanFormats([{ key: 'a', date: 'Date', amount: 'Amount', skip: ['buy', 5] }])[0].skip.length, 1);
});

test('a file is read by itself: in and out columns, one amount column, investment buys left out, account digits from the top of the file', async () => {
  const { autoMap, accountText, accountDigitsInText } = await import('../app/src/parsers.js');
  const two = autoMap(BROKER);
  assert.deepEqual([two.date, two.credit, two.debit, two.amount], ['Trade Date', 'Amount In', 'Amount Out', undefined]);
  assert.ok(two.skip.includes('bought'));                                   // it saw buys, so it is an investment file
  assert.deepEqual(parseMapped(BROKER, two, 'a').transactions.map(t => t.cents), [100000, 310, -5000]);
  const one = autoMap('Date,Description,Amount\n03/01/2026,INTEREST,1.25\n03/02/2026,TRANSFER IN,500.00');
  assert.deepEqual([one.amount, one.skip.length], ['Amount', 0]);
  assert.equal(autoMap('Posted,Memo,Value\n2026-04-01,INTEREST,1.10'), null);   // no date column it can be sure of: it asks
  assert.deepEqual(accountDigitsInText(accountText(BROKER)), ['3013']);           // from the top, not from the transfer descriptions
});
