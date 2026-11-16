// Backing into opening balances. A statement tells you a balance on some day; the transactions since the opening date tell you
// how much moved. Balance on that day, less what moved, is where the account stood on the opening date. Any number of known
// balances can be used, and when they disagree it means a transaction is missing between them (a statement you haven't added).

// Chase bank files carry the running balance on every line, but the lines come oldest-first in some downloads and newest-first
// in others. Which way is worked out from the numbers themselves. Returns the balance at the END of each day: [{ date, cents }].
export function endOfDayBalances(lines) {                      // lines: [{ date, cents, bal }] in file order
  const rows = lines.filter(l => Number.isInteger(l.bal));
  if (!rows.length) return [];
  let asc = 0, desc = 0;
  for (let i = 0; i + 1 < rows.length; i++) {
    if (rows[i + 1].bal === rows[i].bal + rows[i + 1].cents) asc++;
    if (rows[i].bal === rows[i + 1].bal + rows[i].cents) desc++;
  }
  const chrono = desc > asc ? [...rows].reverse() : rows;     // oldest first
  const last = new Map();
  for (const r of chrono) last.set(r.date, r.bal);              // the last line of a day holds that day's closing balance
  return [...last].map(([date, cents]) => ({ date, cents })).sort((a, b) => a.date.localeCompare(b.date));
}

export const dayBefore = iso => new Date(Date.parse(iso + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);

// Anchors are { account, date, cents, kind }. Cents are as the statement reads: what you have, or what you owe on a card.
export function mergeAnchors(existing, incoming) {
  const key = a => `${a.account}|${a.date}`;
  const map = new Map((existing ?? []).map(a => [key(a), a]));
  for (const a of incoming ?? []) {
    const old = map.get(key(a));
    if (!old || old.kind !== 'entered' || a.kind === 'entered') map.set(key(a), a);       // a balance you typed is not overwritten by a file
  }
  const next = [...map.values()].sort((a, b) => a.account.localeCompare(b.account) || a.date.localeCompare(b.date));
  return JSON.stringify(next) === JSON.stringify(existing ?? []) ? (existing ?? []) : next;     // unchanged stays the same array
}

export function cleanAnchors(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(a => a && typeof a.account === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.date) && Number.isInteger(a.cents) && a.cents >= -1e12 && a.cents <= 1e12)
    .map(a => ({ account: a.account, date: a.date, cents: a.cents, kind: a.kind === 'entered' ? 'entered' : 'file' }));
}

// Where each account stood at the end of `openingDate`, worked out from its known balances. roles: key -> 'asset' | 'liability'.
// Returns { [accountKey]: { cents, from: date, kind, checks: [{ date, kind, ok, off }] } }; `off` is how far a later balance is from what
// the transactions say it should be (cents, in the account's own direction).
export function deriveOpening(txs, anchors, openingDate, roles) {
  const out = {};
  const by = new Map();
  for (const a of anchors) { if (!by.has(a.account)) by.set(a.account, []); by.get(a.account).push(a); }
  for (const [account, list] of by) {
    const liability = roles[account] === 'liability';
    const mine = txs.filter(t => t.account === account && t.date > openingDate);
    const implied = a => {
      let moved = 0;
      for (const t of mine) if (t.date <= a.date) moved += t.cents;
      return liability ? a.cents + moved : a.cents - moved;          // a purchase on a card is negative cents but raises what you owe
    };
    const usable = list.filter(a => a.date > openingDate).sort((a, b) => a.date.localeCompare(b.date));
    if (!usable.length) continue;
    // a balance you typed in is the one you trust; otherwise the earliest balance the files give
    const first = usable.find(a => a.kind === 'entered') ?? usable[0];
    const base = implied(first);
    const checks = usable.filter(a => a !== first).map(a => ({ date: a.date, kind: a.kind, off: implied(a) - base }))
      .map(c => ({ ...c, ok: c.off === 0 }));
    out[account] = { cents: base, from: first.date, kind: first.kind, checks };
  }
  return out;
}
