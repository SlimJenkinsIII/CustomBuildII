import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCustoms, applyParents, applyRemoved, applyCoding, addAccount, selectableCategories, hasKids, moveAccount, cleanParents } from '../app/src/categories.js';

test('an account with sub accounts under it cannot be picked for a charge; its sub accounts can', () => {
  applyRemoved({}, {}); applyCoding({});
  const a = addAccount([], {}, 'savings', 'Rainy day', '', { number: '1230' });
  const b = addAccount(a.customs, {}, 'savings', 'Rainy day cash', '', { number: '1235' });
  applyCustoms(b.customs); applyParents({});
  assert.ok(selectableCategories([]).some(c => c.id === a.id));                  // alone, it is a normal account
  assert.equal(hasKids(a.id), false);
  const moved = moveAccount({ coding: {}, parents: {}, customs: b.customs }, b.id, a.id);
  applyCustoms(moved.customs); applyParents(cleanParents(moved.parents)); applyCoding(moved.coding);
  assert.equal(hasKids(a.id), true);
  const ids = selectableCategories([]).map(c => c.id);
  assert.ok(!ids.includes(a.id));                                                // now a main account: not offered
  assert.ok(ids.includes(b.id));                                                 // its sub account is
  applyParents({}); applyCustoms([]); applyCoding({});
});
