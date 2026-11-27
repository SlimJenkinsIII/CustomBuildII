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

// Returns the transactions with each matching VENMO bank line turned into a transfer to Venmo, plus the Venmo payment "TO SAM SAMPLE: Rent share". Each detail is used once, and the
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
  // A payment funded from the bank is really two moves: money from the bank into Venmo (a transfer), then out of Venmo to the person
  // (the spending). The bank line becomes the transfer; two Venmo lines are added: the money arriving, and the payment out. Your coding
  // on the bank line carries to the payment (see `fromBank`), so nothing has to be done again.
  return txs.flatMap((t, i) => {
    if (!reword.has(i)) return [t];
    const into = { id: `${t.id}#vin`, account: 'venmo', date: t.date, cents: -t.cents, description: 'VENMO TRANSFER FROM BANK', source: 'venmo', fromBankLine: t.id, transfer: 'matched', pairId: t.id, fixedPair: true };
    const paid = { id: `${t.id}#vpay`, account: 'venmo', date: t.date, cents: t.cents, description: reword.get(i), source: 'venmo', fromBank: t.id, viaVenmo: true };
    return [{ ...t, bankDescription: t.description, description: `${t.description.split(/\s+/).slice(0, 2).join(' ')} → Venmo (${reword.get(i).slice(3)})`, transfer: 'matched', pairId: into.id, fixedPair: true, fundsVenmo: true }, into, paid];
  });
}

// Any bank or card line that mentions Venmo is money moving between that account and Venmo. Run after transfers are matched:
// what found its other half already is left alone. For the rest:
//   - money out to Venmo: a transfer into Venmo, plus the Venmo payment it paid for (to sort), the same as a payment the Venmo file
//     explains; so the spending is never lost and the bank line is never left in Needs review
//   - money in from Venmo (a cash-out): a transfer from Venmo, waiting for its other half if your Venmo file doesn't cover it
export function bridgeVenmo(txs) {
  return txs.flatMap(t => {
    if (t.account === 'venmo' || t.byHand || t.fixedPair || t.transfer === 'matched' || !/venmo/i.test(t.description ?? '')) return [t];
    if (t.cents > 0) return [{ ...t, venmoCashIn: true }];
    const into = { id: `${t.id}#vin`, account: 'venmo', date: t.date, cents: -t.cents, description: 'VENMO TRANSFER FROM BANK', source: 'venmo', fromBankLine: t.id, transfer: 'matched', pairId: t.id, fixedPair: true };
    const paid = { id: `${t.id}#vpay`, account: 'venmo', date: t.date, cents: t.cents, description: 'VENMO PAYMENT (who and why aren’t in your Venmo file)', source: 'venmo', fromBank: t.id, viaVenmo: true };
    return [{ ...t, bankDescription: t.bankDescription ?? t.description, description: `${t.description.split(/\s+/).slice(0, 2).join(' ')} → Venmo`, transfer: 'matched', pairId: into.id, fixedPair: true, fundsVenmo: true }, into, paid];
  });
}
