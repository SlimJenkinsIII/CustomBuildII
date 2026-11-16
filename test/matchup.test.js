import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAccountList, applyCustoms, applyNames, applyCoding, applyParents, applyRemoved, addAccount, SOURCE_ACCOUNTS, CATEGORIES, isRemoved, resolveCategory } from '../app/src/categories.js';
import { addFromList } from '../app/src/accounts.js';
import { suggestPairs, applyMatchup, cleanMerged } from '../app/src/matchup.js';
import { openingAccounts } from '../app/src/journal.js';

function setup() {
  applyRemoved({}, {}); applyParents({}); applyCustoms([]); applyCoding({});
  const a = addFromList([], 'Chase Checkings (1044)\nChase Savings (8527)', {});
  applyAccountList(a.accounts);
  let customs = [];
  const ven = addAccount(customs, {}, 'savings', 'Venmo', '', { number: '1055' }); customs = ven.customs;
  const sav = addAccount(customs, {}, 'savings', 'Chase Savings (8527)', '', { number: '1210' }); customs = sav.customs;
  applyCustoms(customs);
  return { customs, ven: ven.id, sav: sav.id };
}
const state = (s, extra = {}) => ({ coding: {}, names: {}, parents: {}, merged: {}, overrides: {}, learned: {}, opening: { date: '2024-12-31', balances: {} }, ...extra });

test('hand-made Venmo and Chase Savings are paired with their statement accounts by name and digits', () => {
  const s = setup();
  const pairs = suggestPairs();
  const by = id => pairs.find(p => p.from === id);
  assert.equal(by(s.ven).target, 'venmo');
  assert.equal(by(s.sav).target, 'chase-bank-8527');
  // the built-in placeholders with no file import are offered but not matched
  assert.equal(by('save_amex').target, null);
});

test('matching keeps your number and name, moves coding to transfer, carries the opening balance and retires the old one', () => {
  const s = setup();
  const st = state(s, { overrides: { t1: s.ven, t2: 'food' }, opening: { date: '2024-12-31', balances: { [s.ven]: 5000 } } });
  const out = applyMatchup(st, [{ from: s.ven, target: 'venmo' }, { from: s.sav, target: 'chase-bank-8527' }]);
  assert.equal(out.coding['src:venmo'], '1055');
  assert.equal(out.names['src:venmo'], 'Venmo');
  assert.equal(out.coding['src:chase-bank-8527'], '1210');
  assert.equal(out.overrides.t1, 'transfer');
  assert.equal(out.overrides.t2, 'food');
  assert.equal(out.opening.balances['src:venmo'], 5000);
  assert.equal(out.opening.balances[s.ven], undefined);
  assert.deepEqual(out.merged, { [s.ven]: 'venmo', [s.sav]: 'chase-bank-8527' });
  // nothing was changed in place
  assert.equal(st.overrides.t1, s.ven);
  applyRemoved({}, out.merged); applyCoding(out.coding); applyNames(out.names);
  assert.ok(isRemoved(s.ven));
  assert.equal(resolveCategory(s.ven), 'transfer');
  assert.equal(SOURCE_ACCOUNTS.venmo.code, '1055');
  assert.ok(!openingAccounts().some(a => a.key === s.ven));
  assert.ok(suggestPairs().every(p => p.from !== s.ven));
});

test('two hand-made accounts cannot claim one statement account, and unknown ones are ignored', () => {
  const s = setup();
  const out = applyMatchup(state(s), [{ from: s.ven, target: 'venmo' }, { from: s.sav, target: 'venmo' }, { from: 'nope', target: 'venmo' }]);
  assert.deepEqual(out.merged, { [s.ven]: 'venmo' });
});

test('saved matches are cleaned of accounts that no longer exist', () => {
  const s = setup();
  assert.deepEqual(cleanMerged({ [s.ven]: 'venmo', gone: 'venmo', [s.sav]: 'zzz' }), { [s.ven]: 'venmo' });
  assert.deepEqual(cleanMerged(null), {});
});
