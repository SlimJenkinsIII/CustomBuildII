import test from 'node:test';
import assert from 'node:assert/strict';
import { withIds, mergeTransactions, mergeIntoAccount } from '../app/src/ledger.js';
import { parseStatement } from '../app/src/parsers.js';
import { matchTransfers } from '../app/src/transfers.js';
import { categorize } from '../app/src/rules.js';
import { buildJournal, totalsOf, trialBalance } from '../app/src/journal.js';
import { SOURCE_ACCOUNTS, SOURCE_ROLES, applyAccountList, last4Of, familyOf } from '../app/src/categories.js';
import { cleanAccounts, digitsInName, accountForFile, guessType, addFromList, setLast4, addAccountOfType, setType } from '../app/src/accounts.js';

const reset = () => applyAccountList([]);
const CHASE = (rows) => 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n' + rows.map(r => `${r[3] < 0 ? 'DEBIT' : 'CREDIT'},${r[0]},"${r[1]}",${r[2]},ACCT_XFER,0,,`).join('\n');

test('the last four digits in a file name are found, and years and dates are not mistaken for them', () => {
  assert.deepEqual(digitsInName('Chase1044_Activity_20260105.CSV'), ['1044']);
  assert.deepEqual(digitsInName('Chase_8527_Activity_2026.csv'), ['8527', '2026']);
  assert.deepEqual(digitsInName('activity.csv'), []);
  assert.deepEqual(digitsInName('Statement 6426 (1).CSV'), ['6426']);
});

test('your pasted list becomes accounts: the first of each kind takes over the one that exists, the rest are added', () => {
  try {
    const out = addFromList([], [
      'Chase Checkings (1044)', 'Chase Savings (1899)', 'Chase Savings (8527)', 'Amex High-Yield Savings (6348)', 'JPMorgan (3013)', 'Coinbase',
      'Chase Credit Card (6426)', 'Southwest Credit Card (1458)', 'Amex Credit Card (1000)'].join('\n'));
    assert.deepEqual(out.report.claimed, ['Chase Checkings (1044)', 'Chase Credit Card (6426)', 'Amex Credit Card (1000)']);
    assert.deepEqual(out.report.created, ['Chase Savings (1899)', 'Chase Savings (8527)', 'Amex High-Yield Savings (6348)', 'JPMorgan (3013)', 'Coinbase', 'Southwest Credit Card (1458)']);
    assert.deepEqual(out.renames, { 'src:chase-checking': 'Chase Checkings (1044)', 'src:chase-card': 'Chase Credit Card (6426)', 'src:amex': 'Amex Credit Card (1000)' });
    const byKey = Object.fromEntries(out.accounts.map(a => [a.key, a]));
    assert.equal(byKey['chase-checking'].last4, '1044');
    assert.deepEqual([byKey['savings-1899'].role, byKey['savings-1899'].type, byKey['savings-1899'].last4], ['asset', 'savings', '1899']);
    assert.deepEqual([byKey['savings-6348'].type, byKey['investment-3013'].type, byKey['card-1458'].type, byKey['card-1458'].role], ['savings', 'investment', 'card', 'liability']);
    assert.equal(out.accounts.find(a => a.name === 'Coinbase').type, 'investment');
    const codes = out.accounts.filter(a => a.code).map(a => a.code);
    assert.equal(new Set(codes).size, codes.length);                                       // each new account gets its own number
    assert.ok(codes.every(c => /^1\d{3}$|^2\d{3}$/.test(c)));
  } finally { reset(); }
});

test('once accounts are applied, a file is recognised by its digits, and each account has the right type', () => {
  try {
    const out = addFromList([], 'Chase Checking (1044)\nChase Savings (8527)\nSouthwest Credit Card (1458)');
    applyAccountList(out.accounts);
    assert.equal(accountForFile('Chase1044_Activity_20260105.CSV'), 'chase-checking');
    assert.equal(accountForFile('Chase8527_Activity_20260105.CSV'), 'savings-8527');
    assert.equal(accountForFile('Chase1458_Activity.CSV'), 'chase-card');                  // the first card takes over the built-in card account
    assert.equal(accountForFile('Chase9999_Activity.CSV'), null);                          // digits nobody has: ask
    assert.equal(accountForFile('activity.csv'), null);
    assert.equal(SOURCE_ROLES['savings-8527'], 'asset');
    assert.equal(SOURCE_ROLES['chase-card'], 'liability');
    assert.equal(familyOf('savings-8527'), 'chase-bank');
    assert.equal(last4Of('chase-checking'), '1044');
    applyAccountList([]);
    assert.equal(SOURCE_ACCOUNTS['savings-8527'], undefined);                           // taken away again
  } finally { reset(); }
});

test('a digit string can belong to one account only, and bad digits are refused', () => {
  assert.throws(() => setLast4([{ key: 'chase-checking', last4: '1044' }], 'amex', '1044'), /already belongs/);
  assert.throws(() => setLast4([], 'amex', '12'), /last 4 digits/);
  assert.deepEqual(setLast4([{ key: 'chase-checking', last4: '1044' }], 'chase-checking', ''), [{ key: 'chase-checking', last4: '' }]);
  assert.throws(() => addAccountOfType([{ key: 'chase-checking', last4: '1044' }], { name: 'X', type: 'savings', last4: '1044' }), /already belongs/);
  assert.throws(() => addAccountOfType([], { name: '  ', type: 'savings', last4: '1111' }), /name/);
  assert.throws(() => addAccountOfType([], { name: 'X', type: 'nope', last4: '1111' }), /kind/);
});

test('saved accounts are cleaned: junk, duplicates and unknown kinds are dropped', () => {
  const out = cleanAccounts([
    { key: 'chase-checking', last4: '1044' }, { key: 'chase-checking', last4: '9999' },
    { key: 'chase-bank-8527', name: 'Chase Savings', family: 'chase-bank', role: 'asset', code: '1050', last4: '8527' },
    { key: 'x', name: 'Bad key', family: 'chase-bank', role: 'asset', code: '1060', last4: '' },
    { key: 'weird-1', name: 'Bad kind', family: 'nope', role: 'asset', code: '1070', last4: '' },
    { key: 'dup-1111', name: 'Same digits', family: 'amex', role: 'liability', code: '2030', last4: '1044' },
    7, null,
  ]);
  assert.deepEqual(out.map(a => a.key), ['chase-checking', 'chase-bank-8527', 'dup-1111']);
  assert.equal(out.find(a => a.key === 'dup-1111').last4, '');                          // the digits were already taken
});

test('kinds are guessed from the words', () => {
  assert.equal(guessType('Chase Checkings (1044)'), 'checking');
  assert.equal(guessType('Chase Savings (8527)'), 'savings');
  assert.equal(guessType('Amex High-Yield Savings (6348)'), 'savings');
  assert.equal(guessType('Southwest Credit Card (1458)'), 'card');
  assert.equal(guessType('Amex Credit Card (1000)'), 'card');
  assert.equal(guessType('Venmo'), 'venmo');
  assert.equal(guessType('JPMorgan (3013)'), 'investment');
  assert.equal(guessType('Coinbase'), 'investment');
});

test('an asset can change between checking, savings and investment, but never to a card', () => {
  const list = addFromList([], 'Chase Savings (8527)').accounts;
  const key = list.find(a => a.last4 === '8527').key;
  applyAccountList(list);
  try {
    assert.equal(setType(list, key, 'investment').find(a => a.key === key).type, 'investment');
    assert.throws(() => setType(list, key, 'card'), /asset and a credit card/);
  } finally { reset(); }
});

const t = (account, date, cents, description) => ({ account, date, cents, description });

test('re-importing a file under its own account MOVES the lines already imported, keeping their ids so your coding stays', () => {
  const defaultOnes = withIds([t('chase-checking', '2026-10-19', -20000, 'Online Transfer to SAV ...8527 transaction#: 1'), t('chase-checking', '2026-10-20', 4500, 'INTEREST PAYMENT')]);
  const overrides = { [defaultOnes[1].id]: 'other_interest' };                        // you coded the interest by hand
  const savingsFile = withIds([t('chase-bank-8527', '2026-10-20', 4500, 'INTEREST PAYMENT'), t('chase-bank-8527', '2026-10-25', 300, 'INTEREST PAYMENT')]);
  const out = mergeIntoAccount(defaultOnes, savingsFile, 'chase-bank-8527', 'chase-checking');
  assert.equal(out.movedCount, 1);
  assert.equal(out.addedCount, 1);                                                      // the Oct 25 line was new
  const moved = out.merged.find(e => e.id === defaultOnes[1].id);
  assert.equal(moved.account, 'chase-bank-8527');
  assert.equal(moved.id, defaultOnes[1].id);                                            // same id: the coding is still attached
  assert.equal(overrides[moved.id], 'other_interest');
  assert.equal(out.merged.find(e => e.id === defaultOnes[0].id).account, 'chase-checking');   // lines not in that file stay put
});

test('importing the same file again adds nothing, even after its lines were moved', () => {
  const existing = withIds([t('chase-checking', '2026-10-20', 4500, 'INTEREST PAYMENT')]);
  const file = () => withIds([t('chase-bank-8527', '2026-10-20', 4500, 'INTEREST PAYMENT')]);
  const first = mergeIntoAccount(existing, file(), 'chase-bank-8527', 'chase-checking');
  const second = mergeIntoAccount(first.merged, file(), 'chase-bank-8527', 'chase-checking');
  assert.deepEqual([second.addedCount, second.movedCount, second.skippedCount], [0, 0, 1]);
  assert.equal(second.merged.length, 1);
  assert.equal(mergeTransactions(first.merged, file()).addedCount, 0);                  // the plain merge knows about it too
});

test('two identical charges are moved one for one, never both onto one line', () => {
  const existing = withIds([t('chase-checking', '2026-10-20', -450, 'COFFEE'), t('chase-checking', '2026-10-20', -450, 'COFFEE')]);
  const file = withIds([t('chase-bank-8527', '2026-10-20', -450, 'COFFEE')]);
  const out = mergeIntoAccount(existing, file, 'chase-bank-8527', 'chase-checking');
  assert.equal(out.movedCount, 1);
  assert.equal(out.merged.filter(e => e.account === 'chase-bank-8527').length, 1);
  assert.equal(out.merged.filter(e => e.account === 'chase-checking').length, 1);
});

test('a file for the default account itself is an ordinary import', () => {
  const existing = withIds([t('chase-checking', '2026-10-20', -450, 'COFFEE')]);
  const out = mergeIntoAccount(existing, withIds([t('chase-checking', '2026-10-20', -450, 'COFFEE'), t('chase-checking', '2026-10-21', -100, 'GUM')]), 'chase-checking', 'chase-checking');
  assert.deepEqual([out.addedCount, out.movedCount, out.skippedCount], [1, 0, 1]);
});

test('once the two halves of a transfer sit in different accounts they pair, and the books show money leaving one and entering the other', () => {
  try {
    applyAccountList(addFromList([], 'Chase Checking (1044)\nChase Savings (8527)').accounts);
    const rows = categorize(matchTransfers(withIds([
      t('chase-checking', '2026-10-19', -40000, 'Online Transfer to SAV ...8527 transaction#: 31092522089'),
      t('chase-bank-8527', '2026-10-19', 40000, 'Online Transfer from CHK ...1044 transaction#: 31092522089'),
      t('chase-checking', '2026-10-01', 300000, 'ACME CORP PAYROLL'),
    ])));
    assert.deepEqual(rows.slice(0, 2).map(r => r.transfer), ['matched', 'matched']);
    for (const e of buildJournal(rows)) { const x = totalsOf([e]); assert.equal(x.debit, x.credit); }
    const move = buildJournal(rows).find(e => e.txIds.length === 2);
    assert.deepEqual(move.lines.map(l => l.key).sort(), ['src:chase-bank-8527', 'src:chase-checking']);
    const tb = trialBalance(rows, '2026', '', { date: '2025-12-31', balances: {} });
    const by = k => tb.rows.find(r => r.key === k).balByMonth['2026-10'];
    assert.equal(by('src:chase-bank-8527'), 40000);                                      // savings went up by $400
    assert.equal(by('src:chase-checking'), 300000 - 40000);                              // checking went down by $400
    assert.equal(tb.totals.difference['2026-10'], 0);
  } finally { reset(); }
});

test('Venmo, a card and a savings file each parse as before, and carry the account they are given', () => {
  const rows = parseStatement(CHASE([['10/19/2026', 'INTEREST PAYMENT', '4.50', 1]]), 'chase-bank-8527').transactions;
  assert.equal(rows[0].account, 'chase-bank-8527');
  assert.equal(parseStatement(CHASE([['10/19/2026', 'X', '4.50', 1]])).transactions[0].account, 'chase-checking');
});
