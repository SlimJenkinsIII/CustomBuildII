// Coding many items at once: pick any number of transactions, choose an account, and they all move.
// Your choice goes in `overrides` (transaction id -> account), the same place a single choice goes, so it is
// saved, synced and beaten by nothing but a later choice of yours. Everything here is plain functions.

// "WHOLEFDS MKT #10234 AUSTIN TX" -> "WHOLEFDS MKT": the first words without numbers or punctuation, so every store
// number and every location of the same merchant lines up. Used to select all of a merchant in one tap.
export function merchantKey(description) {
  const words = String(description ?? '').toUpperCase().replace(/[^A-Z ]+/g, ' ').split(/\s+/).filter(w => w.length >= 2);
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
