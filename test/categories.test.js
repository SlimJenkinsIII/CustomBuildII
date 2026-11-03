import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatement } from '../app/src/parsers.js';
import { withIds } from '../app/src/ledger.js';
import { matchTransfers } from '../app/src/transfers.js';
import { categorize } from '../app/src/rules.js';
import { CATEGORIES } from '../app/src/categories.js';
import { defaultRules } from '../app/src/rules.js';

const load = f => withIds(parseStatement(readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8')).transactions);
const tx = (account, date, cents, description) => withIds([{ account, date, cents, description }])[0];
const cat = (t, opts) => categorize(matchTransfers([t]), opts)[0];

test('every default rule points at a real category', () => {
  for (const rule of defaultRules) assert.ok(CATEGORIES[rule.category], rule.contains);
});

test('sample statements are categorized sensibly', () => {
  const all = categorize(matchTransfers([...load('FAKE-chase-checking.csv'), ...load('FAKE-chase-card.csv'), ...load('FAKE-amex.csv')]));
  const by = d => all.find(t => t.description.includes(d)).category;
  assert.equal(by('PAYROLL'), 'income_paycheck');
  assert.equal(by('WHOLEFDS'), 'free_groceries');
  assert.equal(by('BLUE BOTTLE'), 'free_coffee');
  assert.equal(by('NETFLIX'), 'sub_streaming');
  assert.equal(by('SHELL OIL'), 'free_transport');
  assert.equal(by('PAYMENT TO AMEX'), 'transfer');
  assert.equal(by('VENMO'), 'review'); // unknown until Venmo is imported
});

test('whole-word matching: SHELL does not match SHELLEYS', () => {
  assert.equal(cat(tx('card', '2026-03-01', -2000, "SHELLEY'S BAKERY")).category, 'review');
  assert.equal(cat(tx('card', '2026-03-01', -2000, 'SHELL OIL 57444')).category, 'free_transport');
});

test('sign matters: a refund from Netflix is not a subscription charge', () => {
  assert.equal(cat(tx('card', '2026-03-01', 1549, 'NETFLIX.COM')).category, 'review');
});

test('your rules beat the defaults', () => {
  const userRules = [{ contains: 'WHOLEFDS', category: 'free_other' }];
  assert.equal(cat(tx('card', '2026-03-01', -5000, 'WHOLEFDS MKT'), { userRules }).category, 'free_other');
});

test('unknown category in a rule is rejected', () => {
  assert.throws(() => cat(tx('card', '2026-03-01', -5000, 'X'), { userRules: [{ contains: 'X', category: 'nope' }] }), /unknown category/);
});

test('transfer into a savings account counts as savings; receiving side is ignored', () => {
  const out = tx('chase-checking', '2026-03-06', -50000, 'ONLINE TRANSFER TO SAV');
  const inn = tx('chase-savings', '2026-03-06', 50000, 'ONLINE TRANSFER FROM CHK');
  const [a, b] = categorize(matchTransfers([out, inn]), { savingsAccounts: { 'chase-savings': 'save_chase' } });
  assert.equal(a.category, 'save_chase');
  assert.equal(b.category, 'transfer');
});

test('big restaurant bills prompt a reimbursement question; small ones do not', () => {
  const big = cat(tx('card', '2026-03-01', -18500, 'CHIPOTLE'));
  const small = cat(tx('card', '2026-03-01', -1500, 'CHIPOTLE'));
  assert.equal(big.askReimbursement, true);
  assert.equal(small.askReimbursement, undefined);
});
