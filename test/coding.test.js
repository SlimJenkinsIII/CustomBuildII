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

// ---------- names and sub accounts ----------
import { applyNames, setName, cleanNames, applyCustoms, cleanCustoms, addSub, removeSub, nextSubCode } from '../app/src/categories.js';
const resetAll = () => { applyCustoms([]); applyNames({}); applyCoding({}); };

test('an account can be renamed, and the name shows everywhere', () => {
  try {
    let names = setName({}, 'free_groceries', 'Food at home');
    applyNames(names);
    assert.equal(codeLabel('free_groceries'), '5430 Food at home');
    assert.equal(codingList([], {}, names).find(r => r.key === 'free_groceries').renamed, true);
    applyNames(names = setName(names, 'src:amex', 'Amex Gold'));
    assert.equal(sourceLabel('amex'), '2010 Amex Gold');
  } finally { resetAll(); }
  assert.equal(codeLabel('free_groceries'), '5430 Groceries');
});

test('names: blanks are refused, trips and system accounts are not renamed here, saved names are cleaned', () => {
  assert.throws(() => setName({}, 'free_groceries', '  '), /name/i);
  assert.throws(() => setName({}, 'vac1_food', 'x'), /cannot be renamed/);
  assert.throws(() => setName({}, 'review', 'x'), /cannot be renamed/);
  assert.deepEqual(cleanNames({ free_groceries: 'Food', nope: 'x', vac1_food: 'x', free_coffee: 'Coffee' }), { free_groceries: 'Food' });
  assert.deepEqual(setName({ free_groceries: 'Food' }, 'free_groceries', 'Groceries'), {});
});

test('a sub account takes the next free number under its parent', () => {
  assert.equal(nextSubCode('1100', new Set(['1100'])), '1110');
  assert.equal(nextSubCode('1100', new Set(['1110'])), '1120');
  assert.equal(nextSubCode('5110', new Set()), '5111');
  assert.throws(() => nextSubCode('5455', new Set()), /no room/);
  assert.equal(nextSubCode('5400', new Set(Array.from({ length: 9 }, (_, i) => String(5410 + i * 10)))), '5401');
  assert.throws(() => nextSubCode('5110', new Set(Array.from({ length: 9 }, (_, i) => String(5111 + i)))), /no free numbers/);
});

test('adding a sub account makes a real category in the parent\'s group, and the next one follows it', () => {
  try {
    let customs = [];
    const a = addSub(customs, {}, 'free_restaurants', 'Date nights');   // 5400 -> 5410 is Coffee, so 5420 is Bars, ...
    assert.equal(a.code, '5460');
    customs = a.customs; applyCustoms(customs);
    assert.equal(CATEGORIES[a.id].group, 'free');
    assert.equal(codeLabel(a.id), `${a.code} Date nights`);
    const b = addSub(customs, {}, 'free_restaurants', 'Takeout');
    assert.notEqual(b.code, a.code);
    assert.equal(b.code, '5401');   // 5460 was the last free multiple of 10, so the next steps by 1
    assert.ok(codingList([], {}).some(r => r.key === a.id && r.custom));
    // it can be renumbered and renamed like any other account
    applyNames(setName({}, a.id, 'Dinner out'));
    assert.equal(CATEGORIES[a.id].name, 'Dinner out');
    // sub account of a sub account
    const c = addSub([...customs], {}, a.id, 'Anniversary');
    assert.equal(c.code, '5461');
  } finally { resetAll(); }
  assert.equal(Object.values(CATEGORIES).some(x => x.custom), false);
});

test('a new sub account skips numbers already used', () => {
  try {
    // 1100 Investment account: 1110 is Crypto and 1120 is the reserved Venmo balance, so the first free is 1130
    const a = addSub([], {}, 'save_invest', 'Brokerage 2');
    assert.equal(a.code, '1130');
  } finally { resetAll(); }
});

test('removing a sub account also removes the ones under it', () => {
  try {
    const a = addSub([], {}, 'save_invest', 'A'); applyCustoms(a.customs);
    const b = addSub(a.customs, {}, a.id, 'B');
    const out = removeSub(b.customs, a.id);
    assert.deepEqual(out.customs, []);
    assert.equal(out.removed.length, 2);
  } finally { resetAll(); }
});

test('saved sub accounts are cleaned: bad parents, bad numbers, duplicates and blanks are dropped', () => {
  const good = { id: 'sub_abc', parent: 'free_coffee', code: '5415', name: 'Cafe' };
  const out = cleanCustoms([good, { ...good, id: 'sub_dup' }, { id: 'sub_x', parent: 'nope', code: '5416', name: 'x' },
    { id: 'sub_y', parent: 'free_coffee', code: '54', name: 'x' }, { id: 'sub_z', parent: 'free_coffee', code: '5417', name: ' ' },
    { id: 'sub_v', parent: 'vac1_food', code: '5418', name: 'trip' }, { id: 'sub_k', parent: 'sub_abc', code: '5416', name: 'Child' }]);
  assert.deepEqual(out.map(x => x.id), ['sub_abc', 'sub_k']);
});

test('a sub account is picked up by the income statement under its own line', () => {
  try {
    const a = addSub([], {}, 'free_coffee', 'Cafe'); applyCustoms(a.customs);
    const t = { id: 'x', date: '2026-03-02', cents: -450, description: 'CAFE', account: 'chase-checking', category: a.id };
    const m = monthlyMatrix([t], '2026', '2026-03-31');
    assert.equal(m.lines.find(l => l.id === a.id).total, 450);
  } finally { resetAll(); }
});
