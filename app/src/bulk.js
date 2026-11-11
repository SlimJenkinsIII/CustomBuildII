// Coding many items at once: pick any number of transactions, choose an account, and they all move.
// Your choice goes in `overrides` (transaction id -> account), the same place a single choice goes, so it is
// saved, synced and beaten by nothing but a later choice of yours. Everything here is plain functions.

// "WHOLEFDS MKT #10234 AUSTIN TX" -> "WHOLEFDS MKT": the first words without numbers or punctuation, so every store
// number and every location of the same merchant lines up. Card-processor prefixes ("TST*", "SQ *") are skipped, so
// "TST* BLUE BOTTLE" and "BLUE BOTTLE COFFEE" read as the same place. Used to select, and to remember, a merchant.
const PREFIXES = new Set(['TST', 'SQ', 'SP', 'POS', 'DEBIT', 'PURCHASE', 'CHECKCARD', 'RECURRING', 'PMT']);
export function merchantKey(description) {
  const tokens = String(description ?? '').toUpperCase().split(/\s+/).filter(Boolean);
  // The name is what comes before the first store number ("CHIPOTLE 1234 AUSTIN TX" -> CHIPOTLE): what follows is a place.
  let words = [];
  for (const tok of tokens) {
    if (/[0-9#]/.test(tok)) break;
    const w = tok.replace(/[^A-Z]/g, '');
    if (w.length >= 2) words.push(w);
  }
  // No number to go by (or it came first, as in "7-ELEVEN 33071"): use the letters, without numbers or punctuation.
  if (!words.length) words = String(description ?? '').toUpperCase().replace(/[^A-Z ]+/g, ' ').split(/\s+/).filter(w => w.length >= 2);
  while (words.length > 1 && PREFIXES.has(words[0])) words = words.slice(1);
  return words.slice(0, 2).join(' ');
}

// Which transactions to list. view: 'review' (still unsorted) or 'all'. q: words to find in the description.
// ym: one month, or ''. Newest first.
export function filterItems(txs, { view = 'review', q = '', ym = '' } = {}) {
  const words = String(q).trim().toLowerCase().split(/\s+/).filter(Boolean);
  return txs.filter(t => {
    if (t.category === 'transfer') return false;                                  // matched transfers are not coded by hand
    if (view === 'review' && t.category !== 'review') return false;
    if (ym && !t.date.startsWith(ym)) return false;
    if (words.length) { const d = t.description.toLowerCase(); if (!words.every(w => d.includes(w))) return false; }
    return true;
  }).sort((a, b) => b.date.localeCompare(a.date) || a.description.localeCompare(b.description));
}

// Gives each id the account. Returns the new overrides and what to put back to undo it.
// '__auto' hands the items back to the app's own rules.
export function applyBulk(overrides, ids, category) {
  const next = { ...overrides }, previous = {};
  for (const id of ids) {
    previous[id] = overrides[id];                                                  // undefined = there was no choice of yours
    if (category === '__auto') delete next[id]; else next[id] = category;
  }
  return { next, previous };
}

export function undoBulk(overrides, previous) {
  const next = { ...overrides };
  for (const [id, was] of Object.entries(previous)) { if (was === undefined) delete next[id]; else next[id] = was; }
  return next;
}

// Everything in `items` that shares a merchant with the given one.
export const similarTo = (items, description) => {
  const key = merchantKey(description);
  return key ? items.filter(t => merchantKey(t.description) === key).map(t => t.id) : [];
};

// A shift-tap: every id between two rows (inclusive), in the order shown.
export function rangeBetween(ids, a, b) {
  const i = ids.indexOf(a), j = ids.indexOf(b);
  if (i < 0 || j < 0) return [b].filter(x => ids.includes(x));
  return ids.slice(Math.min(i, j), Math.max(i, j) + 1);
}

// ---------- learning from what you choose ----------
// When you code something by hand, the app remembers the merchant and files its other charges, past and future, the same way.
// Your choice on one specific charge always wins over what was learned. The last choice you make for a merchant is the one kept.
// Some names cover many kinds of purchase, so choosing one of them teaches nothing.
const GENERIC = new Set(['AMAZON', 'AMZN', 'PAYPAL', 'VENMO', 'ZELLE', 'CASH', 'SQUARE', 'APPLE', 'GOOGLE', 'PAYMENT', 'ONLINE', 'TRANSFER', 'ATM', 'CHECK', 'WITHDRAWAL', 'DEPOSIT', 'MOBILE', 'WIRE', 'FEE', 'INTEREST', 'EBAY', 'ETSY', 'WALMART', 'TARGET', 'COSTCO']);

import { isFuelStop } from './fuel.js';

// What to remember a charge by, or null when it isn't safe to (too vague, or a name that covers everything).
export function learnKey(description) {
  const key = merchantKey(description);
  if (isFuelStop(description)) return null;                      // gas stations are split by amount instead of remembered whole
  if (key.replace(/ /g, '').length < 3) return null;
  if (GENERIC.has(key.split(' ')[0])) return null;
  return key;
}

export function cleanLearned(raw, isCategory = () => true) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, r] of Object.entries(raw)) {
    if (typeof key === 'string' && key.length <= 60 && r && typeof r.c === 'string' && isCategory(r.c) && ['', 'in', 'out'].includes(r.s ?? '')) out[key] = { c: r.c, s: r.s ?? '' };
  }
  return out;
}

// After you code `items` as `category`: returns the new memory, the merchants now remembered, and the ones it won't guess about.
// '__auto' (let the app decide) makes it forget those merchants.
export function learn(learned, items, category) {
  const next = { ...learned }, remembered = [], skipped = [], seen = new Set();
  const bySign = {};
  for (const t of items) { const k = learnKey(t.description); if (k) (bySign[k] ??= new Set()).add(t.cents < 0 ? 'out' : 'in'); }
  for (const t of items) {
    const key = learnKey(t.description);
    if (!key) { const raw = merchantKey(t.description); if (raw && !seen.has(raw)) { seen.add(raw); skipped.push(raw); } continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    if (category === '__auto') { delete next[key]; continue; }
    next[key] = { c: category, s: bySign[key].size === 1 ? [...bySign[key]][0] : '' };
    remembered.push(key);
  }
  return { next, remembered, skipped };
}

export const forget = (learned, key) => { const next = { ...learned }; delete next[key]; return next; };

// Files each charge by what was learned, except matched transfers. Anything you coded on a single charge is applied later and wins.
export function applyLearned(txs, learned, isCategory = () => true) {
  if (!Object.keys(learned).length) return txs;
  return txs.map(t => {
    if (t.transfer === 'matched' || t.category === 'transfer') return t;
    const r = learned[merchantKey(t.description)];
    if (!r || !isCategory(r.c) || r.c === t.category) return t;
    if ((r.s === 'in' && t.cents <= 0) || (r.s === 'out' && t.cents >= 0)) return t;
    return { ...t, category: r.c, categoryReason: 'learned from your choices' };
  });
}
