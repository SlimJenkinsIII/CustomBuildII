import test from 'node:test';
import assert from 'node:assert/strict';
import { withIds } from '../app/src/ledger.js';
import { matchTransfers } from '../app/src/transfers.js';
import { categorize } from '../app/src/rules.js';
import { glExport, chartExport, toCsv, exportFileName, GL_HEADER } from '../app/src/glexport.js';
import { applyCustoms, applyParents, applyCoding, addAccount, moveAccount } from '../app/src/categories.js';

const run = rows => categorize(matchTransfers(withIds(rows)));
const tx = (account, date, cents, description) => ({ account, date, cents, description });
const DATA = () => run([
  tx('chase-checking', '2026-01-06', 300000, 'ACME CORP PAYROLL'),
  tx('amex', '2026-01-10', -8412, "WHOLEFDS MKT #10234 AUSTIN TX"),
  tx('amex', '2026-02-03', -4120, 'SHELL OIL 57444 AUSTIN TX'),
  tx('amex', '2026-02-20', 30000, 'MOBILE PAYMENT - THANK YOU'),
  tx('chase-checking', '2026-03-05', -1999, 'MYSTERY MERCHANT 5521'),
]);

test('every entry is exported as balanced debit and credit lines, in date order', () => {
  const out = glExport(DATA());
  assert.deepEqual(out.header, GL_HEADER);
  assert.equal(out.entries, 5);
  assert.equal(out.debit, out.credit);                                          // the export balances, like the books
  const dates = out.rows.map(r => r[0]);
  assert.deepEqual(dates, [...dates].sort());
  const groceries = out.rows.filter(r => r[2] === '5430');
  assert.equal(groceries.length, 1);
  assert.equal(groceries[0][4], '84.12');                                       // an expense is a debit, in dollars and cents
  assert.equal(groceries[0][5], '');
  assert.equal(out.rows.filter(r => r[2] === '2010').find(r => r[4] === '300.00')[5], '');   // the card payment lowers what you owe: a debit
});

test('a place after the store number is dropped from the merchant name', () => {
  const rows = glExport(run([tx('amex', '2026-03-01', -1500, 'CHIPOTLE 1234 AUSTIN TX')])).rows;
  assert.ok(rows.every(r => r[6] === 'CHIPOTLE'));
});

test('a date range keeps only the entries inside it, both ends included', () => {
  const out = glExport(DATA(), { from: '2026-02-03', to: '2026-02-20' });
  assert.equal(out.entries, 2);
  assert.ok(out.rows.every(r => r[0] >= '2026-02-03' && r[0] <= '2026-02-20'));
  assert.equal(glExport(DATA(), { from: '2027-01-01' }).rows.length, 0);
  assert.equal(glExport(DATA(), { to: '2026-01-31' }).entries, 2);
});

test('merchant names drop store numbers and places; full keeps the bank\'s wording; none leaves names out', () => {
  const merchant = glExport(DATA(), { names: 'merchant' }).rows.filter(r => r[2] === '5430')[0][6];
  assert.equal(merchant, 'WHOLEFDS MKT');
  assert.ok(!/10234|AUSTIN/.test(JSON.stringify(glExport(DATA(), { names: 'merchant' }).rows)));
  assert.equal(glExport(DATA(), { names: 'full' }).rows.filter(r => r[2] === '5430')[0][6], 'WHOLEFDS MKT #10234 AUSTIN TX');
  const none = glExport(DATA(), { names: 'none' });
  assert.ok(none.rows.every(r => r[6] === ''));
  assert.ok(!/WHOLEFDS|SHELL|ACME|MYSTERY/.test(JSON.stringify(none.rows)));
});

test('it says how each item was filed, in plain words', () => {
  const out = glExport(DATA());
  const how = acct => out.rows.find(r => r[2] === acct)[8];
  assert.equal(how('5430'), 'automatic rule');
  assert.equal(how('5900'), 'needs review');
  assert.equal(glExport(DATA().map(t => (t.description.startsWith('WHOLEFDS') ? { ...t, chosen: true } : t))).rows.find(r => r[2] === '5430')[8], 'your choice');
});

test('the bank or card is named without any account number', () => {
  const out = glExport(DATA());
  assert.ok(out.rows.some(r => r[7] === 'Amex card') && out.rows.some(r => r[7] === 'Chase checking'));
  assert.ok(!out.rows.some(r => /\d{4,}/.test(r[7])));
});

test('a card payment with the other half not imported exports as a transfer, against transfers in transit', () => {
  const out = glExport(DATA(), { from: '2026-02-20', to: '2026-02-20' });
  assert.deepEqual(out.rows.map(r => r[2]).sort(), ['1910', '2010']);
  assert.equal(out.rows[0][8], 'transfer between accounts');
});

test('CSV quotes what needs it and defuses anything a spreadsheet would run as a formula', () => {
  const csv = toCsv(['A', 'B'], [['x,y', 'say "hi"'], ['=SUM(A1)', '+1 555'], ['-12.50', '@home'], ['line\nbreak', 'ok']]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'A,B');
  assert.equal(lines[1], '"x,y","say ""hi"""');
  assert.equal(lines[2], "'=SUM(A1),'+1 555");
  assert.equal(lines[3], "-12.50,'@home");                                   // a plain negative number is left alone
  assert.equal(lines[4], '"line\nbreak",ok');
  assert.ok(csv.endsWith('\r\n'));
});

test('the account list carries your own accounts and what sits under what', () => {
  try {
    const a = addAccount([], {}, 'subscriptions', 'Netflix'); applyCustoms(a.customs);
    const st = moveAccount({ coding: {}, parents: {}, customs: a.customs }, a.id, 'sub_streaming');
    applyCustoms(st.customs); applyParents(st.parents); applyCoding(st.coding);
    const chart = chartExport([]);
    const row = chart.rows.find(r => r[1] === 'Netflix');
    assert.deepEqual(row, ['5230', 'Netflix', 'Expenses', 'Subscriptions']);
    assert.ok(chart.rows.some(r => r[0] === '5900' && r[1] === 'Needs review'));
  } finally { applyParents({}); applyCustoms([]); applyCoding({}); }
});

test('file names say what range they cover', () => {
  assert.equal(exportFileName('2026-01-01', '2026-03-31'), 'gl-export-2026-01-01-to-2026-03-31.csv');
  assert.equal(exportFileName('', ''), 'gl-export-all.csv');
  assert.equal(exportFileName('2026-01-01', '', 'chart'), 'chart-export-2026-01-01-to-latest.csv');
});
