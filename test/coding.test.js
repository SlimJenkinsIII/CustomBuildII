import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, SOURCE_ACCOUNTS, applyCoding, setCode, cleanCoding, codingList, codeLabel, sourceLabel, defaultCode, chartOfAccounts } from '../app/src/categories.js';
import { categorize } from '../app/src/rules.js';
import { monthlyMatrix } from '../app/src/insights.js';

const tx = (date, cents, description, account = 'chase-checking') => ({ id: date + description, date, cents, description, account });
const reset = () => applyCoding({});

test('renumbering an account changes its label everywhere it is shown', () => {
  try {
    const coding = setCode({}, 'free_groceries', '5455');
    applyCoding(coding);
    assert.equal(codeLabel('free_groceries'), '5455 Groceries');
    assert.equal(CATEGORIES.free_groceries.code, '5455');
    assert.ok(chartOfAccounts().some(a => a.code === '5455' && a.name === 'Groceries'));
  } finally { reset(); }
  assert.equal(codeLabel('free_groceries'), '5430 Groceries');
});

test('source accounts (banks and cards) can be renumbered too', () => {
  try {
    applyCoding(setCode({}, 'src:amex', '2050'));
    assert.equal(sourceLabel('amex'), '2050 Amex card');
  } finally { reset(); }
  assert.equal(sourceLabel('amex'), '2010 Amex card');
});

test('numbers must be four digits and unique', () => {
  assert.throws(() => setCode({}, 'free_groceries', '543'), /4-digit/);
  assert.throws(() => setCode({}, 'free_groceries', 'abcd'), /4-digit/);
  assert.throws(() => setCode({}, 'free_groceries', '5410'), /5410 is already used by Coffee/);   // another account's number
  assert.throws(() => setCode({}, 'free_groceries', '1200'), /already used by 401\(k\)/);         // a planned account's number
  assert.throws(() => setCode({}, 'src:amex', '5100'), /already used by Rent/);
  assert.throws(() => setCode({}, 'nope', '1234'), /cannot be renumbered/);
  assert.throws(() => setCode({}, 'transfer', '1234'), /cannot be renumbered/);
});

test('swapping two numbers works in two steps, and setting a number back to its default removes the change', () => {
  const a = setCode({}, 'free_coffee', '5999');                 // free up 5410
  const b = setCode(a, 'free_groceries', '5410');
  assert.equal(b.free_coffee, '5999');
  assert.equal(b.free_groceries, '5410');
  const back = setCode(setCode(b, 'free_groceries', '5430'), 'free_coffee', '5410');
  assert.deepEqual(back, {});                                   // nothing differs from the defaults any more
});

test('saved coding is cleaned: unknown accounts, bad numbers and no-op entries are dropped', () => {
  assert.deepEqual(cleanCoding({ free_groceries: '5455', nope: '1234', free_coffee: 'xx', free_gifts: '5480', 'src:amex': '2050' }),
    { free_groceries: '5455', 'src:amex': '2050' });
  assert.deepEqual(cleanCoding(null), {});
  assert.deepEqual(cleanCoding('hello'), {});
});

test('the table follows your numbers: order and header ranges', () => {
  try {
    applyCoding(setCode({}, 'free_groceries', '5999'));
    const rows = categorize([tx('2026-01-02', -500, 'STARBUCKS'), tx('2026-01-03', -4000, 'HEB #404'), tx('2026-01-04', -900, 'TOTAL WINE')]);
    const m = monthlyMatrix(rows, '2026');
    const free = m.lines.filter(l => l.kind === 'row' && l.group === 'free');
    assert.deepEqual(free.map(l => l.code), ['5410', '5420', '5999']);     // groceries moved to the end
    assert.equal(m.lines.find(l => l.kind === 'header' && l.label === 'Free cash').code, '5400–5999'.replace('5999', '5999'));
  } finally { reset(); }
});

test('the coding screen lists every visible account in number order, marking planned ones as fixed', () => {
  const list = codingList([], {});
  assert.deepEqual(list.map(r => r.code), [...list.map(r => r.code)].sort());
  assert.ok(list.find(r => r.key === 'src:chase-checking').editable);
  assert.equal(list.find(r => r.name === '401(k) & retirement').editable, false);
  assert.ok(!list.some(r => r.key === 'vac3_food'));                       // trip blocks that don't exist yet are hidden
  assert.ok(codingList([{ slot: 3, name: 'X' }], {}).some(r => r.key === 'vac3_food'));
  assert.equal(codingList([], { free_coffee: '5999' }).find(r => r.key === 'free_coffee').changed, true);
  assert.equal(defaultCode('free_coffee'), '5410');
});
