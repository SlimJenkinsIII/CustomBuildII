import test from 'node:test';
import assert from 'node:assert/strict';
import { withIds, orphanAccounts, moveOrphans, dropAccountLines, mergeIntoAccount } from '../app/src/ledger.js';

const t = (account, date, cents, description) => ({ account, date, cents, description });
const raw = withIds([t('old-savings', '2026-01-05', 500, 'INTEREST'), t('old-savings', '2026-01-09', -100, 'TRANSFER'), t('savings-8527', '2026-01-09', -100, 'TRANSFER')]);

test('lines under an account that no longer exists are found', () => {
  assert.deepEqual(orphanAccounts(raw, k => k === 'savings-8527'), [{ key: 'old-savings', count: 2, first: '2026-01-05', last: '2026-01-09' }]);
});

test('moving them in skips lines already there and keeps your coding', () => {
  const [a, b, c] = raw;
  const out = moveOrphans(raw, { [a.id]: 'other_interest', [b.id]: 'transfer' }, 'old-savings', 'savings-8527');
  assert.equal(out.moved, 1); assert.equal(out.merged, 1);
  assert.equal(out.raw.length, 2);
  assert.equal(out.overrides[c.id], 'transfer');                         // the coding moved onto the copy already there
  assert.equal(out.overrides[a.id], 'other_interest');                   // the moved line keeps its id and coding
  // the statement uploaded again adds nothing
  const again = mergeIntoAccount(out.raw, withIds([t('savings-8527', '2026-01-05', 500, 'INTEREST')]), 'savings-8527', 'chase-checking');
  assert.equal(again.addedCount, 0);
});

test('or they can be deleted, with their coding', () => {
  const out = dropAccountLines(raw, { [raw[0].id]: 'x', [raw[2].id]: 'y' }, 'old-savings');
  assert.equal(out.count, 2); assert.equal(out.raw.length, 1); assert.deepEqual(Object.keys(out.overrides), [raw[2].id]);
});
