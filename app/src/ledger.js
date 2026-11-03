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

// Merge new transactions into existing ones, skipping any id already present.
export function mergeTransactions(existing, incoming) {
  const have = new Set(existing.map(t => t.id));
  const added = incoming.filter(t => !have.has(t.id));
  return { merged: [...existing, ...added], addedCount: added.length, skippedCount: incoming.length - added.length };
}
