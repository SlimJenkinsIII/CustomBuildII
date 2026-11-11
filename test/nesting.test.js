import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, applyCoding, applyCustoms, applyParents, applyRemoved, addAccount, moveAccount, applyTripNames } from '../app/src/categories.js';
import { nestRows, addMaps } from '../app/src/nesting.js';

const reset = () => { applyParents({}); applyRemoved({}); applyCustoms([]); applyCoding({}); };
const row = (key, total) => ({ key, code: CATEGORIES[key]?.code ?? '0000', name: CATEGORIES[key]?.name ?? key, total, byMonth: { '2026-03': total } });
const rollup = list => ({ total: list.reduce((t, r) => t + r.total, 0), byMonth: addMaps(list.map(r => r.byMonth)) });

test('addMaps adds objects keyed by month', () => {
  assert.deepEqual(addMaps([{ a: 1, b: 2 }, { a: 3 }, undefined]), { a: 4, b: 2 });
});

test('a parent account shows the sum of what is under it, then its sub accounts follow', () => {
  try {
    const a = addAccount([], {}, 'subscriptions', 'Netflix'); applyCustoms(a.customs);
    const out = moveAccount({ coding: {}, parents: {}, customs: a.customs }, a.id, 'sub_streaming');
    applyCustoms(out.customs); applyParents(out.parents); applyCoding(out.coding);
    const rows = [row('sub_streaming', 1000), row(a.id, 1599), row('sub_other', 700)];
    const e = nestRows(rows, { rollup, hasOwn: r => r.total !== 0 });
    assert.deepEqual(e.map(x => `${x.kind}:${x.key}`), ['parent:sub_streaming', 'own:sub_streaming', `row:${a.id}`, 'row:sub_other']);
    assert.equal(e[0].data.total, 1000 + 1599);           // Subscriptions = its own + Netflix
    assert.equal(e[1].data.total, 1000);                  // its own money stays visible on an (other) line
    assert.match(e[1].name, /\(other\)$/);
    assert.equal(e[3].data.total, 700);                   // an account outside the family is untouched
  } finally { reset(); }
});

test('a parent with no money of its own is just the sum, with no (other) line', () => {
  try {
    const hdr = addAccount([], {}, 'header', 'Savings', '', { section: '1' }); applyCustoms(hdr.customs);
    let st = moveAccount({ coding: {}, parents: {}, customs: hdr.customs }, 'save_chase', hdr.id);
    st = moveAccount(st, 'save_amex', hdr.id);
    applyCustoms(st.customs); applyParents(st.parents); applyCoding(st.coding);
    const e = nestRows([row('save_chase', 500), row('save_amex', 300)], { rollup, hasOwn: r => r.total !== 0 });
    assert.deepEqual(e.map(x => x.kind), ['parent', 'row', 'row']);
    assert.equal(e[0].name, 'Savings');
    assert.equal(e[0].data.total, 800);
  } finally { reset(); }
});

test('three levels roll up all the way: the top sums every level below it', () => {
  try {
    const a = addAccount([], {}, 'subscriptions', 'Netflix'); applyCustoms(a.customs);
    const b = addAccount(a.customs, {}, 'subscriptions', 'Netflix 4K'); applyCustoms(b.customs);
    let st = moveAccount({ coding: {}, parents: {}, customs: b.customs }, a.id, 'sub_streaming');
    applyCustoms(st.customs); applyParents(st.parents); applyCoding(st.coding);
    st = moveAccount(st, b.id, a.id);
    applyCustoms(st.customs); applyParents(st.parents); applyCoding(st.coding);
    const e = nestRows([row('sub_streaming', 100), row(a.id, 200), row(b.id, 400)], { rollup, hasOwn: r => r.total !== 0 });
    assert.equal(e.find(x => x.kind === 'parent' && x.key === 'sub_streaming').data.total, 700);
    assert.equal(e.find(x => x.kind === 'parent' && x.key === a.id).data.total, 600);
    assert.equal(e.find(x => x.kind === 'row' && x.key === b.id).data.total, 400);
  } finally { reset(); }
});

test('an account with nothing nested under it is shown as before', () => {
  const e = nestRows([row('fixed_rent', 1), row('fixed_utilities', 2)], { rollup, hasOwn: () => true });
  assert.deepEqual(e.map(x => x.kind), ['row', 'row']);
});

test('a trip shows as one line with the total of its five accounts, and the five sit under it', () => {
  try {
    applyTripNames([{ slot: 1, name: 'Lisbon' }]);
    const rows = [row('vac0_lodging', 30000), row('vac1_travel', 41230), row('vac1_lodging', 90000), row('vac1_food', 12000)];
    const e = nestRows(rows, { rollup, hasOwn: r => r.total !== 0 });
    const trip = e.find(x => x.key === 'vac1');
    assert.equal(trip.kind, 'parent');
    assert.equal(trip.name, 'Lisbon');
    assert.equal(trip.code, '7100');
    assert.equal(trip.data.total, 41230 + 90000 + 12000);                // the trip is the sum of what is under it
    assert.equal(e.find(x => x.key === 'vac0').data.total, 30000);       // the "no trip yet" parent is its own family
    assert.deepEqual(e.map(x => x.key), ['vac0', 'vac0_lodging', 'vac1', 'vac1_travel', 'vac1_lodging', 'vac1_food']);
  } finally { applyTripNames([]); reset(); }
});

import { isHidden } from '../app/src/nesting.js';
import { parentAccounts } from '../app/src/categories.js';

test('a main account is shown even when nothing under it has any activity, with zeros', () => {
  try {
    const hdr = addAccount([], {}, 'header', 'Investments', '', { section: '1' }); applyCustoms(hdr.customs);
    const st = moveAccount({ coding: {}, parents: {}, customs: hdr.customs }, 'save_invest', hdr.id);
    applyCustoms(st.customs); applyParents(st.parents); applyCoding(st.coding);
    const mains = parentAccounts([]).filter(m => m.class === 'Assets');
    assert.deepEqual(mains.map(m => m.name), ['Investments']);
    const e = nestRows([], { rollup, hasOwn: () => false, ghosts: mains });
    assert.deepEqual(e.map(x => [x.kind, x.name]), [['parent', 'Investments']]);
    assert.equal(e[0].data.total, 0);
  } finally { reset(); }
});

test('main accounts come out in number order among the rows, and a real one is not shown twice', () => {
  try {
    const hdr = addAccount([], {}, 'header', 'Savings', '', { section: '1' }); applyCustoms(hdr.customs);
    let st = moveAccount({ coding: {}, parents: {}, customs: hdr.customs }, 'save_chase', hdr.id);
    applyCustoms(st.customs); applyParents(st.parents); applyCoding(st.coding);
    const rows = [{ ...row('src:chase-checking', 500), code: '1000', name: 'Chase checking' }, { ...row('save_chase', 300) }];
    const e = nestRows(rows, { rollup, hasOwn: r => r.total !== 0, ghosts: parentAccounts([]).filter(m => m.class === 'Assets') });
    assert.deepEqual(e.map(x => x.name), ['Chase checking', 'Savings', 'Chase Savings']);
    assert.equal(e.filter(x => x.key === hdr.id).length, 1);
    assert.equal(e[1].data.total, 300);                                   // the parent adds up what is under it
  } finally { reset(); }
});

test('what is folded away is hidden: an entry is shown only when everything above it is open', () => {
  try {
    const a = addAccount([], {}, 'subscriptions', 'Netflix'); applyCustoms(a.customs);
    const st = moveAccount({ coding: {}, parents: {}, customs: a.customs }, a.id, 'sub_streaming');
    applyCustoms(st.customs); applyParents(st.parents); applyCoding(st.coding);
    const e = nestRows([row('sub_streaming', 1000), row(a.id, 1599)], { rollup, hasOwn: r => r.total !== 0 });
    const by = Object.fromEntries(e.map(x => [`${x.kind}:${x.key}`, x]));
    const open = new Set();
    assert.equal(isHidden(by['parent:sub_streaming'], k => open.has(k)), false);                  // the main account itself always shows
    assert.equal(isHidden(by[`row:${a.id}`], k => open.has(k)), true);                            // a sub account is folded away
    assert.equal(isHidden(by['own:sub_streaming'], k => open.has(k)), true);                      // and so is the main account's own "(other)" line
    open.add('sub_streaming');
    assert.equal(isHidden(by[`row:${a.id}`], k => open.has(k)), false);
    assert.equal(isHidden(by['own:sub_streaming'], k => open.has(k)), false);
  } finally { reset(); }
});

test('trips are main accounts once added, and "no trip yet" is not forced', () => {
  const none = parentAccounts([]).map(m => m.key);
  assert.ok(!none.includes('vac1') && !none.includes('vac0'));
  applyTripNames([{ slot: 1, name: 'Lisbon' }]);
  const withTrip = parentAccounts([{ slot: 1, name: 'Lisbon' }]);
  applyTripNames([]);
  assert.ok(withTrip.some(m => m.key === 'vac1' && m.name === 'Lisbon' && m.code === '7100'));
  assert.ok(!withTrip.some(m => m.key === 'vac0'));
});

import { ghostAccounts } from '../app/src/categories.js';

test('every bank, card, Venmo and savings account is listed for the balance sheet, even with nothing in it', () => {
  const names = ghostAccounts([]).map(g => g.name);
  for (const n of ['Chase checking', 'Venmo balance', 'Chase credit card', 'Amex card', 'Chase Savings', 'Amex High-Yield Savings', 'Investment account']) assert.ok(names.includes(n), n);
  const codes = ghostAccounts([]).map(g => g.code);
  assert.deepEqual(codes, [...codes].sort());                                         // in number order
  assert.ok(ghostAccounts([]).filter(g => g.name === 'Venmo balance').every(g => g.leaf && g.class === 'Assets'));
});

test('a savings account you add yourself is listed, and one you delete or nest is handled', () => {
  try {
    const a = addAccount([], {}, 'savings', 'Chase Savings 8527'); applyCustoms(a.customs);
    assert.ok(ghostAccounts([]).some(g => g.key === a.id && g.leaf));
    const hdr = addAccount(a.customs, {}, 'header', 'Savings', '', { section: '1' }); applyCustoms(hdr.customs);
    const st = moveAccount({ coding: {}, parents: {}, customs: hdr.customs }, a.id, hdr.id);
    applyCustoms(st.customs); applyParents(st.parents); applyCoding(st.coding);
    const g = ghostAccounts([]);
    assert.equal(g.find(x => x.key === hdr.id).leaf, false);                          // the Savings parent
    assert.equal(g.find(x => x.key === a.id).leaf, true);                              // and the account under it, still a savings account
    assert.equal(CATEGORIES[a.id].group, 'savings');
  } finally { reset(); }
});

test('an account with nothing in it shows as a zero row under its parent, not as a parent itself', () => {
  try {
    const hdr = addAccount([], {}, 'header', 'Checking', '', { section: '1' }); applyCustoms(hdr.customs);
    const st = moveAccount({ coding: {}, parents: {}, customs: hdr.customs }, 'src:venmo', hdr.id);
    applyCustoms(st.customs); applyParents(st.parents); applyCoding(st.coding);
    const e = nestRows([], { rollup, hasOwn: () => false, ghosts: ghostAccounts([]).filter(g => g.class === 'Assets') });
    const venmo = e.find(x => x.key === 'src:venmo');
    assert.equal(venmo.kind, 'row');
    assert.equal(venmo.data.total, 0);
    assert.deepEqual(venmo.ancestors, [hdr.id]);                                       // so it folds away with its parent
    assert.equal(e.find(x => x.key === hdr.id).kind, 'parent');
  } finally { reset(); }
});

import { repairHeaders, selectableCategories } from '../app/src/categories.js';

test('dragging a savings account under a heading keeps it a savings account (it used to become a heading and vanish)', () => {
  try {
    const a = addAccount([], {}, 'savings', 'Chase Savings 8527'); applyCustoms(a.customs);
    const hdr = addAccount(a.customs, {}, 'header', 'Savings', '', { section: '1' }); applyCustoms(hdr.customs);
    const st = moveAccount({ coding: {}, parents: {}, customs: hdr.customs }, a.id, hdr.id);
    assert.equal(st.customs.find(x => x.id === a.id).group, 'savings');
    assert.equal(st.customs.find(x => x.id === hdr.id).header, true);                 // headings are marked as such
    applyCustoms(st.customs); applyParents(st.parents); applyCoding(st.coding);
    assert.ok(selectableCategories([]).some(c => c.id === a.id));                     // so it can still be picked, and holds a balance
  } finally { reset(); }
});

test('an account dragged under a real account still takes that account\'s kind', () => {
  try {
    const a = addAccount([], {}, 'subscriptions', 'Netflix'); applyCustoms(a.customs);
    const st = moveAccount({ coding: {}, parents: {}, customs: a.customs }, a.id, 'sub_streaming');
    assert.equal(st.customs[0].group, 'subscriptions');
  } finally { reset(); }
});

test('accounts an older version turned into headings are put back as accounts, and real headings are kept', () => {
  const customs = [
    { id: 'sub_aaa', group: 'header', code: '1200', name: 'Savings', match: [] },                      // has something under it: a real heading
    { id: 'sub_bbb', parent: 'sub_aaa', group: 'header', code: '1210', name: 'Chase Savings 8527', match: [] },   // was an account
    { id: 'sub_ccc', parent: 'sub_aaa', group: 'header', code: '1220', name: 'Chase Savings 9911', match: [] },
    { id: 'sub_ddd', group: 'header', code: '1300', name: 'Receivable', header: true, match: [] },     // marked: left alone even though empty
    { id: 'sub_eee', group: 'savings', code: '1400', name: 'Brokerage', match: [] },
  ];
  const fixed = repairHeaders(customs);
  const by = Object.fromEntries(fixed.map(x => [x.id, x]));
  assert.equal(by.sub_aaa.group, 'header');
  assert.equal(by.sub_aaa.header, true);                                                         // now marked
  assert.equal(by.sub_bbb.group, 'savings');                                                     // back to an asset account
  assert.equal(by.sub_ccc.group, 'savings');
  assert.equal(by.sub_ddd.group, 'header');
  assert.equal(by.sub_eee.group, 'savings');
  assert.equal(repairHeaders(fixed), fixed);                                                     // nothing left to fix: untouched
  // a built-in account dragged under a custom heading counts as something under it
  const lone = [{ id: 'sub_fff', group: 'header', code: '1200', name: 'Savings', match: [] }];
  assert.equal(repairHeaders(lone, { save_chase: 'sub_fff' })[0].header, true);
});
