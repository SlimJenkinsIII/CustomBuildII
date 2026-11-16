// "Match up my accounts": the accounts you made by hand on the TB (a Venmo balance, Chase Savings (8527) ...) and the accounts
// that statement files go into are two things for the same account. This pairs them. The statement account keeps YOUR number,
// name and place on the balance sheet; the hand-made one is retired (hidden, reversible) and anything filed under it goes
// to Transfers, which pairs up with the other side by itself.
import { CATEGORIES, SOURCE_ACCOUNTS, SOURCE_ROLES, typeOf, last4Of, parentOf, isRemoved } from './categories.js';

const SAVINGS_GROUP = 'savings';

// The accounts you made by hand (or the built-in savings placeholders) that are still live.
export const handMade = () => Object.values(CATEGORIES)
  .filter(c => c.group === SAVINGS_GROUP && !isRemoved(c.id) && c.code)
  .sort((a, b) => a.code.localeCompare(b.code));

const digitsOf = text => [...String(text).matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map(m => m[1]);

// Which statement account a hand-made one most likely is. Digits in the name win; then the kind (Venmo is Venmo, a Chase savings
// is a savings account) when only one account of that kind is left to take it. null = leave it alone.
export function guessTarget(cat, taken = new Set()) {
  const keys = Object.keys(SOURCE_ACCOUNTS).filter(k => !taken.has(k) && (SOURCE_ROLES[k] ?? 'asset') === 'asset');
  for (const d of digitsOf(cat.name)) { const k = keys.find(x => last4Of(x) === d); if (k) return k; }
  const t = cat.name.toLowerCase();
  const type = /venmo/.test(t) ? 'venmo' : /sav|high-yield/.test(t) ? 'savings' : /invest|jpmorgan|coinbase|crypto/.test(t) ? 'investment' : /check/.test(t) ? 'checking' : null;
  if (!type) return null;
  const same = keys.filter(k => typeOf(k) === type);
  return same.length === 1 ? same[0] : null;
}

// Every hand-made account with the account it looks like, for the screen to show and let you change. Digits in a name are
// settled first for all of them, so a plain "Chase Savings" placeholder can't take the account that "Chase Savings (8527)" is.
export function suggestPairs() {
  const list = handMade(), taken = new Set(), pick = new Map();
  for (const pass of [true, false]) {
    for (const c of list) {
      if (pick.has(c.id)) continue;
      const withDigits = digitsOf(c.name).length > 0;
      if (withDigits !== pass) continue;
      const target = guessTarget(c, taken);
      if (target) { taken.add(target); pick.set(c.id, target); }
    }
  }
  return list.map(c => {
    const target = pick.get(c.id) ?? null;
    return { from: c.id, fromCode: c.code, fromName: c.name, target, targetName: target ? SOURCE_ACCOUNTS[target].name : '' };
  });
}

// What applying does, as plain data so it can be shown first and tested. pairs = [{ from, target }]
// Returns the new { coding, names, parents, merged, overrides, learned, opening } to save; nothing is changed in place.
export function applyMatchup(state, pairs) {
  const coding = { ...state.coding }, names = { ...state.names }, parents = { ...state.parents };
  const merged = { ...state.merged }, overrides = { ...state.overrides }, learned = { ...state.learned };
  const opening = { ...state.opening, balances: { ...(state.opening?.balances ?? {}) } };
  const seen = new Set();
  for (const { from, target } of pairs) {
    const cat = CATEGORIES[from];
    if (!cat || !SOURCE_ACCOUNTS[target] || seen.has(target) || from in merged) continue;
    seen.add(target);
    const key = `src:${target}`;
    // the statement account takes the number, name and place you gave it
    const parent = parentOf(from);
    coding[key] = cat.code;
    names[key] = cat.name;
    if (parent) parents[key] = parent; else delete parents[key];
    delete coding[from]; delete parents[from];
    // an opening balance you entered carries over
    const bal = opening.balances[from];
    if (bal) { opening.balances[key] = (opening.balances[key] ?? 0) + bal; delete opening.balances[from]; }
    // things you coded to it now say "transfer", which pairs with the other side
    for (const [id, cid] of Object.entries(overrides)) if (cid === from) overrides[id] = 'transfer';
    for (const [k, v] of Object.entries(learned)) if (v?.c === from) delete learned[k];
    merged[from] = target;
  }
  return { coding, names, parents, merged, overrides, learned, opening };
}

// Keeps only pairs that still make sense (the hand-made account still exists, the statement account still exists).
export function cleanMerged(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [from, target] of Object.entries(raw)) if (CATEGORIES[from] && CATEGORIES[from].group === SAVINGS_GROUP && SOURCE_ACCOUNTS[target]) out[from] = target;
  return out;
}
