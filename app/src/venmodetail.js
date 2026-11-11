// A Venmo payment you funded from your bank or card is on that statement as a bare "VENMO PAYMENT 1053903953802 WEB ID: ...",
// which says nothing about who you paid or why. The Venmo file knows. So the Venmo importer keeps those payments as DETAIL
// (they are never counted as transactions, so nothing is counted twice), and this lays the who and the note onto the matching
// bank or card line: the same amount, within a few days. The line keeps its id and its place in the ledger; only its words change.

const dayNumber = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);
const MAX_DAYS = 3;
const keyOf = d => `${d.date}|${d.cents}|${d.party}|${d.note}`;

// Adds new detail to what is already kept, without repeating any.
export function mergeDetails(existing, incoming) {
  const seen = new Set(existing.map(keyOf));
  const added = incoming.filter(d => !seen.has(keyOf(d)) && seen.add(keyOf(d)));
  return [...existing, ...added];
}

export function cleanDetails(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(d => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && Number.isInteger(d.cents) && d.cents < 0 && typeof d.party === 'string' && typeof d.note === 'string')
    .map(d => ({ date: d.date, cents: d.cents, party: d.party.slice(0, 80), note: d.note.slice(0, 200) }));
}

// Returns the transactions with matching VENMO lines reworded as "TO SAM SAMPLE: Rent share". Each detail is used once, and the
// closest date wins. A line already reworded, or entered by hand, is left alone.
export function enrichVenmo(txs, details) {
  if (!details.length) return txs;
  const free = new Set(txs.map((_, i) => i).filter(i => !txs[i].byHand && txs[i].cents < 0 && /^VENMO\b/i.test(txs[i].description) && txs[i].account !== 'venmo'));
  const reword = new Map();
  for (const d of [...details].sort((a, b) => a.date.localeCompare(b.date))) {
    let best = -1, bestGap = MAX_DAYS + 1;
    for (const i of free) {
      if (txs[i].cents !== d.cents) continue;
      const gap = Math.abs(dayNumber(txs[i].date) - dayNumber(d.date));
      if (gap < bestGap) { best = i; bestGap = gap; }
    }
    if (best < 0) continue;
    free.delete(best);
    reword.set(best, `TO ${d.party.toUpperCase()}${d.note ? `: ${d.note}` : ''}`);
  }
  return txs.map((t, i) => (reword.has(i) ? { ...t, description: reword.get(i), bankDescription: t.description, viaVenmo: true } : t));
}
