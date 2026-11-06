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
  assert.throws(() => setCode({}, 'free_groceries', '1100'), /already used by Investment account/);
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

test('the coding screen lists every visible account in number order, with bank accounts movable', () => {
  const list = codingList([], {});
  assert.deepEqual(list.map(r => r.code), [...list.map(r => r.code)].sort());
  assert.ok(list.find(r => r.key === 'src:chase-checking').editable);
  assert.equal(list.find(r => r.key === 'src:chase-checking').movable, true);          // bank accounts can be nested too
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
  assert.equal(nextSubCode('5110', new Set()), '5112');
  assert.equal(nextSubCode('5110', new Set(['5112', '5114'])), '5116');
  assert.throws(() => nextSubCode('5455', new Set()), /deepest level/);
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
    assert.equal(c.code, '5462');
  } finally { resetAll(); }
  assert.equal(Object.values(CATEGORIES).some(x => x.custom), false);
});

test('a new sub account skips numbers already used', () => {
  try {
    // 1100 Investment account: 1110 is Crypto, so the first free number is 1120
    const a = addSub([], {}, 'save_invest', 'Brokerage 2');
    assert.equal(a.code, '1120');
  } finally { resetAll(); }
});

test('removing a sub account moves what sat under it up one level', () => {
  try {
    const a = addSub([], {}, 'save_invest', 'A'); applyCustoms(a.customs);
    const b = addSub(a.customs, {}, a.id, 'B'); applyCustoms(b.customs);
    const out = removeSub(b.customs, a.id);
    assert.deepEqual(out.customs.map(x => x.id), [b.id]);
    assert.equal(out.customs[0].parent, 'save_invest');
    assert.deepEqual(removeSub(out.customs, 'save_invest').customs.map(x => x.id), [b.id]);
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

// ---------- deleting (merging) accounts ----------
import { applyRemoved, cleanRemoved, removeAccount, restoreAccount, removeTargets, canRemove, resolveCategory, removedList, selectableCategories } from '../app/src/categories.js';
const resetRemoved = () => { applyRemoved({}); resetAll(); };

test('deleting an account merges it into one of the same kind, and everything follows', () => {
  try {
    const removed = removeAccount({}, 'sub_gym', 'sub_other');
    applyRemoved(removed);
    assert.equal(resolveCategory('sub_gym'), 'sub_other');
    assert.equal(codingList([], {}).some(r => r.key === 'sub_gym'), false);
    assert.equal(selectableCategories([]).some(c => c.id === 'sub_gym'), false);
    assert.equal(chartOfAccounts().some(a => a.code === '5220'), false);
    assert.equal(removedList().find(r => r.key === 'sub_gym').into, 'sub_other');
    // the freed number can be used again
    assert.doesNotThrow(() => setCode({}, 'sub_other', '5220'));
  } finally { resetRemoved(); }
  assert.equal(resolveCategory('sub_gym'), 'sub_gym');
});

test('four subscription accounts can be folded into one', () => {
  try {
    let removed = {};
    for (const id of ['sub_streaming', 'sub_software', 'sub_gym']) removed = removeAccount(removed, id, 'sub_other');
    applyRemoved(removed);
    assert.deepEqual(['sub_streaming', 'sub_software', 'sub_gym'].map(resolveCategory), ['sub_other', 'sub_other', 'sub_other']);
    assert.equal(codingList([], {}).filter(r => r.class === 'Expenses' && /^52/.test(r.code)).length, 1);
  } finally { resetRemoved(); }
});

test('merging into an account that is itself deleted later follows it on', () => {
  try {
    let removed = removeAccount({}, 'sub_gym', 'sub_software');
    applyRemoved(removed);
    removed = removeAccount(removed, 'sub_software', 'sub_other');
    applyRemoved(removed);
    assert.equal(resolveCategory('sub_gym'), 'sub_other');
    assert.equal(removed.sub_gym, 'sub_other');
  } finally { resetRemoved(); }
});

test('only same-kind accounts are offered, and savings, trips, banks and the last account of a kind stay', () => {
  assert.ok(removeTargets('sub_gym').every(t => /^52/.test(t.code)));
  assert.equal(canRemove('save_chase'), false);
  assert.equal(canRemove('vac1_food'), false);
  assert.equal(canRemove('review'), false);
  assert.equal(canRemove('onetime_annual'), false);   // the only account of its kind
  assert.equal(canRemove('sub_gym'), true);
  assert.throws(() => removeAccount({}, 'sub_gym', 'free_coffee'), /same kind/);
  assert.throws(() => removeAccount({}, 'save_chase', 'save_amex'), /cannot be deleted/);
});

test('a deleted account can be restored', () => {
  try {
    const removed = removeAccount({}, 'sub_gym', 'sub_other');
    assert.deepEqual(restoreAccount(removed, 'sub_gym'), {});
    applyRemoved(restoreAccount(removed, 'sub_gym'));
    assert.equal(resolveCategory('sub_gym'), 'sub_gym');
  } finally { resetRemoved(); }
});

test('saved deletions are cleaned: unknown accounts, other kinds, loops and sub accounts are dropped', () => {
  assert.deepEqual(cleanRemoved({ sub_gym: 'sub_other', nope: 'sub_other', sub_software: 'free_coffee', save_chase: 'save_amex', sub_other: 'sub_other' }), { sub_gym: 'sub_other' });
  assert.deepEqual(cleanRemoved({ sub_gym: 'sub_software', sub_software: 'sub_gym' }), {});
  assert.deepEqual(cleanRemoved(null), {});
});

test('transactions filed under a deleted account show under the one it moved into', () => {
  try {
    applyRemoved(removeAccount({}, 'sub_gym', 'sub_other'));
    const t = { id: 'g', date: '2026-03-02', cents: -4000, description: 'PLANET FITNESS', account: 'chase-checking', category: resolveCategory('sub_gym') };
    const m = monthlyMatrix([t], '2026', '2026-03-31');
    assert.equal(m.lines.find(l => l.id === 'sub_other').total, 4000);
    assert.equal(m.lines.some(l => l.id === 'sub_gym'), false);
  } finally { resetRemoved(); }
});

// ---------- sub accounts that file charges by keyword ----------
import { customRules, setMatch, cleanMatch } from '../app/src/categories.js';
import { categorize as categorizeTx } from '../app/src/rules.js';

test('match words are cleaned: upper-cased, short ones dropped, duplicates removed, at most five', () => {
  assert.deepEqual(cleanMatch('netflix, Netflix , ab, hulu'), ['NETFLIX', 'HULU']);
  assert.deepEqual(cleanMatch(''), []);
  assert.equal(cleanMatch('aaa,bbb,ccc,ddd,eee,fff').length, 5);
});

test('a sub account with match words gets those charges, ahead of the built-in rules', () => {
  try {
    const a = addSub([], {}, 'sub_streaming', 'Netflix', 'netflix');
    applyCustoms(a.customs);
    const txs = [
      { id: '1', date: '2026-03-02', cents: -1599, description: 'NETFLIX.COM 866-579-7172 CA', account: 'chase-card' },
      { id: '2', date: '2026-03-03', cents: -1099, description: 'SPOTIFY USA 877', account: 'chase-card' },
    ];
    const out = categorizeTx(txs, { userRules: customRules(a.customs) });
    assert.equal(out[0].category, a.id);
    assert.equal(out[1].category, 'sub_streaming');   // the built-in rule still handles the rest
    assert.equal(CATEGORIES[a.id].group, 'subscriptions');
    // match words can be changed later, and refunds (money in) are not swept in
    const changed = setMatch(a.customs, a.id, 'hulu');
    assert.deepEqual(changed[0].match, ['HULU']);
    const refund = categorizeTx([{ ...txs[0], id: '3', cents: 1599 }], { userRules: customRules(a.customs) });
    assert.notEqual(refund[0].category, a.id);
  } finally { resetAll(); }
});

test('saved sub accounts keep their match words through cleaning', () => {
  const out = cleanCustoms([{ id: 'sub_n', parent: 'sub_streaming', code: '5230', name: 'Netflix', match: ['netflix', 'x'] }]);
  assert.deepEqual(out[0].match, ['NETFLIX']);
});

// ---------- adding top-level accounts and dragging them ----------
import { addAccount, moveAccount, nextHundred, applyParents, cleanParents, parentOf, depthOf } from '../app/src/categories.js';
const resetStructure = () => { applyParents({}); resetRemoved(); };

test('a new account takes the next free hundred in its section', () => {
  try {
    assert.equal(nextHundred('5', new Set(['5000', '5100', '5200'])), '5300');
    const a = addAccount([], {}, 'subscriptions', 'Netflix');
    assert.equal(a.code, '5300');       // 5100, 5200 and 5400 are taken in the starting chart
    applyCustoms(a.customs);
    assert.equal(CATEGORIES[a.id].group, 'subscriptions');
    const b = addAccount(a.customs, {}, 'free', 'Pets');
    assert.equal(b.code, '5500');
    assert.equal(addAccount([], {}, 'income', 'Side work').code, '4100');
    assert.equal(addAccount([], {}, 'savings', 'Brokerage').code, '1200');
  } finally { resetStructure(); }
});

test('dragging an account under another numbers it in tens, skipping what is taken', () => {
  try {
    const a = addAccount([], {}, 'subscriptions', 'Netflix'); applyCustoms(a.customs);
    // 5200 is Subscriptions; 5210, 5220 and 5290 are already used
    const out = moveAccount({ coding: {}, parents: {}, customs: a.customs }, a.id, 'sub_streaming');
    applyCustoms(out.customs); applyParents(out.parents);
    assert.equal(out.coding[a.id], '5230');
    assert.equal(parentOf(a.id), 'sub_streaming');
    assert.equal(depthOf(a.id), 1);
    // the next one goes to 5240; one under Netflix goes in twos: 5232
    const b = addAccount(out.customs, out.coding, 'subscriptions', 'Hulu'); applyCustoms(b.customs);
    const out2 = moveAccount({ ...out, customs: b.customs }, b.id, 'sub_streaming');
    assert.equal(out2.coding[b.id], '5240');
    const c = addAccount(out2.customs, out2.coding, 'subscriptions', 'Netflix 4K'); applyCustoms(c.customs); applyCoding(out2.coding);
    const out3 = moveAccount({ ...out2, customs: c.customs }, c.id, a.id);
    assert.equal(out3.coding[c.id], '5232');
    assert.throws(() => moveAccount({ ...out3 }, 'sub_gym', c.id), /deepest level|three levels/);
  } finally { resetStructure(); }
});

test('the spec example: under 5100 with 5110 taken, the next one is 5120', () => {
  assert.equal(nextSubCode('5100', new Set(['5110'])), '5120');
});

test('built-in accounts can be dragged too, and their number and parent follow', () => {
  try {
    const out = moveAccount({ coding: {}, parents: {}, customs: [] }, 'sub_gym', 'sub_streaming');
    applyParents(out.parents); applyCoding(out.coding);
    assert.equal(parentOf('sub_gym'), 'sub_streaming');
    assert.equal(CATEGORIES.sub_gym.code, '5220');   // 5210 is taken, so Gym stays at 5220, now nested under Subscriptions
    // and back to the top of the section: a standard hundred
    const back = moveAccount({ ...out }, 'sub_gym', 'top');
    applyParents(back.parents); applyCoding(back.coding);
    assert.equal(parentOf('sub_gym'), undefined);
    assert.match(CATEGORIES.sub_gym.code, /00$/);
  } finally { resetStructure(); }
});

test('moving an account carries everything under it, renumbered', () => {
  try {
    let st = { coding: {}, parents: {}, customs: [] };
    const a = addAccount(st.customs, st.coding, 'free', 'Pets'); applyCustoms(a.customs); st.customs = a.customs;
    const b = addAccount(st.customs, st.coding, 'free', 'Vet'); applyCustoms(b.customs); st.customs = b.customs;
    st = moveAccount(st, b.id, a.id); applyParents(st.parents); applyCoding(st.coding);   // Vet under Pets
    assert.equal(st.coding[b.id], String(Number(a.code) + 10));
    applyCustoms(st.customs);
    const to = moveAccount({ ...st, customs: st.customs }, a.id, 'sub_streaming');        // Pets (with Vet) under Subscriptions 5200
    assert.equal(to.coding[a.id], '5230');
    assert.equal(to.coding[b.id], '5232');                                                // and Vet follows, in twos
  } finally { resetStructure(); }
});

test('accounts stay in their own section, and nothing goes under itself or its own child', () => {
  try {
    assert.throws(() => moveAccount({ coding: {}, parents: {}, customs: [] }, 'fixed_rent', 'save_chase'), /own section/);
    assert.throws(() => moveAccount({ coding: {}, parents: {}, customs: [] }, 'fixed_rent', 'fixed_rent'), /can’t go under/);
    assert.throws(() => moveAccount({ coding: {}, parents: {}, customs: [] }, 'vac1_food', 'top'), /can’t be moved/);
  } finally { resetStructure(); }
});

test('saved parents are cleaned: unknown accounts, loops and your own accounts are dropped', () => {
  assert.deepEqual(cleanParents({ sub_gym: 'sub_streaming', nope: 'sub_streaming', sub_other: 'nope', vac1_food: 'sub_gym', sub_software: 'sub_software' }), { sub_gym: 'sub_streaming' });
  assert.deepEqual(cleanParents(null), {});
});

// ---------- parent accounts, nestable bank accounts, and the assets layout ----------
import { organizeAssets, isHeader, headersAbove } from '../app/src/categories.js';

test('a parent account holds no money: it is not offered for transactions, and it takes the number you give it', () => {
  try {
    const a = addAccount([], {}, 'header', 'Checking', '', { section: '1' });
    assert.equal(a.code, '1200');                                   // lowest free hundred in assets
    const b = addAccount(a.customs, {}, 'header', 'Savings', '', { number: '1500' });
    assert.equal(b.code, '1500');
    applyCustoms(b.customs);
    assert.equal(isHeader(a.id), true);
    assert.equal(selectableCategories([]).some(c => c.id === a.id), false);
    assert.equal(codingList([], {}).some(r => r.key === a.id && r.header), true);
    assert.throws(() => addAccount(b.customs, {}, 'header', 'X', '', { number: '1500' }), /already used by Savings/);
    assert.throws(() => addAccount([], {}, 'header', 'X'), /Choose which section/);
    assert.throws(() => addAccount([], {}, 'fixed', 'X', '', { number: '1234' }), /5000s/);
  } finally { resetStructure(); }
});

test('bank accounts can be nested under a parent account, and their number follows', () => {
  try {
    const hdr = addAccount([], {}, 'header', 'Checking', '', { section: '1' }); applyCustoms(hdr.customs);
    const out = moveAccount({ coding: {}, parents: {}, customs: hdr.customs }, 'src:chase-checking', hdr.id);
    applyParents(out.parents); applyCoding(out.coding);
    assert.equal(parentOf('src:chase-checking'), hdr.id);
    assert.equal(SOURCE_ACCOUNTS['chase-checking'].code, String(Number(hdr.code) + 10));
    assert.deepEqual(headersAbove('src:chase-checking'), [hdr.id]);
    assert.equal(depthOf('src:chase-checking'), 1);
  } finally { resetStructure(); }
});

test('the assets layout: Checking 1000, Savings 1200, Accounts Receivable 1300, Investments 1400 with your accounts nested', () => {
  try {
    const st = organizeAssets({});
    applyCustoms(st.customs); applyParents(st.parents); applyCoding(st.coding);
    const code = k => (k.startsWith('src:') ? SOURCE_ACCOUNTS[k.slice(4)] : CATEGORIES[k]).code;
    assert.deepEqual(['src:chase-checking', 'save_chase', 'save_amex', 'save_invest', 'save_crypto'].map(code), ['1010', '1210', '1220', '1410', '1420']);
    const heads = st.customs.filter(x => x.group === 'header');
    assert.deepEqual(heads.map(x => `${x.code} ${x.name}`), ['1000 Checking', '1200 Savings', '1300 Accounts Receivable', '1400 Investments']);
    const friends = st.customs.find(x => x.name === 'Due from friends');
    assert.equal(friends.code, '1310');
    assert.equal(friends.parent, heads[2].id);
    assert.equal(parentOf('save_amex'), heads[1].id);
    assert.equal(depthOf('save_crypto'), 1);
    // all numbers are unique, and a second run is refused rather than doubled up
    const all = [...Object.values(CATEGORIES).filter(x => x.code).map(x => x.code), ...Object.values(SOURCE_ACCOUNTS).map(x => x.code)];
    assert.equal(new Set(all).size, all.length);
    assert.throws(() => organizeAssets(st), /already in use/);
  } finally { resetStructure(); }
});

test('saved nesting of a bank account survives cleaning', () => {
  try {
    const hdr = addAccount([], {}, 'header', 'Checking', '', { section: '1' }); applyCustoms(hdr.customs);
    assert.deepEqual(cleanParents({ 'src:chase-checking': hdr.id, 'src:nope': hdr.id }), { 'src:chase-checking': hdr.id });
  } finally { resetStructure(); }
});
