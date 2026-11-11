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
