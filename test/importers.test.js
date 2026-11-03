import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatement, toCents, toIsoDate } from '../app/src/parsers.js';
import { withIds, mergeTransactions } from '../app/src/ledger.js';
import { parseCsv } from '../app/src/csv.js';

const sample = f => readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');

test('amounts become integer cents', () => {
  assert.equal(toCents('-84.12'), -8412);
  assert.equal(toCents('$1,234.50'), 123450);
  assert.equal(toCents('(5.00)'), -500);
  assert.equal(toCents('0.1'), 10);
  assert.throws(() => toCents('abc'));
});

test('dates become ISO', () => assert.equal(toIsoDate('3/4/2026'), '2026-03-04'));

test('csv handles quotes and commas', () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi"""\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
});

test('chase checking: spending negative', () => {
  const { format, transactions } = parseStatement(sample('FAKE-chase-checking.csv'));
  assert.equal(format, 'chase-checking');
  assert.equal(transactions.length, 5);
  assert.equal(transactions[0].cents, -8412);
  assert.equal(transactions[2].cents, 210000);
});

test('chase card detected', () => {
  const { format, transactions } = parseStatement(sample('FAKE-chase-card.csv'));
  assert.equal(format, 'chase-card');
  assert.equal(transactions[0].date, '2026-03-02');
});

test('amex: charges flipped to negative, payments positive', () => {
  const { format, transactions } = parseStatement(sample('FAKE-amex.csv'));
  assert.equal(format, 'amex');
  assert.equal(transactions[0].cents, -1549);
  assert.equal(transactions[2].cents, 45000);
});

test('unknown format is rejected with a clear error', () => {
  assert.throws(() => parseStatement('foo,bar\n1,2\n'), /Unrecognized/);
});

test('re-importing the same file adds nothing; identical same-day purchases both kept', () => {
  const t = withIds(parseStatement(sample('FAKE-chase-card.csv'), 'chase-card').transactions);
  assert.equal(t.length, 3); // two identical coffees stay distinct
  assert.notEqual(t[0].id, t[1].id);
  const first = mergeTransactions([], t);
  assert.equal(first.addedCount, 3);
  const again = mergeTransactions(first.merged, withIds(parseStatement(sample('FAKE-chase-card.csv'), 'chase-card').transactions));
  assert.equal(again.addedCount, 0);
  assert.equal(again.skippedCount, 3);
});
