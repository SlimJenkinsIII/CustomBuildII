// Gives every transaction a stable id so re-importing overlapping statements never double-counts.
// Two genuinely identical transactions on the same day (two $4.50 coffees) get #1, #2 in file order,
// so they are both kept the first time and recognised again on a later import.
export function withIds(transactions) {
  const seen = new Map();
  return transactions.map(t => {
    const base = [t.account, t.date, t.cents, t.description.toLowerCase().replace(/\s+/g, ' ')].join('|');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...t, id: `${base}#${n}` };
  });
}

// Merge new transactions into existing ones, skipping any id already present. A transaction that was moved to another account
// remembers the id it would get there (`aliases`), so importing its file again recognises it instead of adding it twice.
export function mergeTransactions(existing, incoming) {
  const have = new Set(existing.flatMap(t => [t.id, ...(t.aliases ?? [])]));
  const added = incoming.filter(t => !have.has(t.id));
  return { merged: [...existing, ...added], addedCount: added.length, skippedCount: incoming.length - added.length };
}

const sameCharge = (a, b) => a.date === b.date && a.cents === b.cents && a.description.toLowerCase().replace(/\s+/g, ' ') === b.description.toLowerCase().replace(/\s+/g, ' ');

// Brings a file in under account `account`. Lines of it that are already imported under the kind's DEFAULT account (because
// they were all imported there together before there were separate accounts) are MOVED to `account`, keeping their id, so
// every choice you made on them stays attached. Lines that are really new are added; lines already under `account` are skipped.
// Returns { merged, addedCount, skippedCount, movedCount }.
export function mergeIntoAccount(existing, incoming, account, defaultAccount) {
  const claimed = new Set();
  const moved = new Map();                                   // existing id -> the id it would have under `account`
  const have = new Set(existing.flatMap(t => [t.id, ...(t.aliases ?? [])]));
  const fresh = [];
  for (const t of incoming) {
    if (have.has(t.id)) continue;
    const mine = account !== defaultAccount && existing.find(e => e.account === defaultAccount && !claimed.has(e.id) && !e.byHand && sameCharge(e, t));
    if (mine) { claimed.add(mine.id); moved.set(mine.id, t.id); continue; }
    fresh.push(t);
  }
  const merged = existing.map(e => (moved.has(e.id) ? { ...e, account, aliases: [...(e.aliases ?? []), moved.get(e.id)] } : e));
  return { merged: [...merged, ...fresh], addedCount: fresh.length, skippedCount: incoming.length - fresh.length - moved.size, movedCount: moved.size };
}
