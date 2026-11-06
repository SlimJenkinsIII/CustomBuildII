import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, applyCoding, applyCustoms, applyParents, applyRemoved, addAccount, moveAccount } from '../app/src/categories.js';
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
