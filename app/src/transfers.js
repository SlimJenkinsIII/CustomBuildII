// Finds money moving between your OWN accounts (e.g. paying the Amex bill from checking)
// so it is not counted as spending or income.
//
// Result is added to each transaction as `transfer`:
//   'matched'   - both sides found, amounts equal and opposite, close dates, and the wording
//                 looks like a payment/transfer. Safe to exclude from spending.
//   'suggested' - amounts and dates line up across accounts but nothing in the wording says
//                 "transfer". Could be a coincidence, so it is held for YOUR review.
//   'unmatched' - wording says payment/transfer but the other side isn't in the imported
//                 files (e.g. Venmo not imported yet). Held for review, not silently counted.
// Matched/suggested transactions also get `pairId` (the id of the other side).

const HINT = /payment|pymt|transfer|xfer|epayment|autopay|zelle|venmo|cash app|paypal|thank you/i;
const MAX_DAYS = 5;

const dayNumber = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);

export function matchTransfers(transactions, { maxDays = MAX_DAYS } = {}) {
  // Rows you entered by hand are not statement rows, so they never pair with one.
  const outs = transactions.filter(t => t.cents < 0 && !t.byHand);
  const ins = transactions.filter(t => t.cents > 0 && !t.byHand);

  // Every possible pairing: money out of one account, same amount into a DIFFERENT account, near in time.
  const candidates = [];
  for (const o of outs) {
    for (const i of ins) {
      if (o.account === i.account || o.cents !== -i.cents) continue;
      const gap = Math.abs(dayNumber(o.date) - dayNumber(i.date));
      if (gap > maxDays) continue;
      candidates.push({ o, i, gap, hinted: HINT.test(o.description) || HINT.test(i.description) });
    }
  }
  // Best first: wording evidence, then closest dates. Each transaction can be used only once.
  candidates.sort((a, b) => (b.hinted - a.hinted) || (a.gap - b.gap));

  const used = new Set();
  const info = new Map(); // id -> { transfer, pairId }
  for (const c of candidates) {
    if (used.has(c.o.id) || used.has(c.i.id)) continue;
    used.add(c.o.id); used.add(c.i.id);
    const transfer = c.hinted ? 'matched' : 'suggested';
    info.set(c.o.id, { transfer, pairId: c.i.id });
    info.set(c.i.id, { transfer, pairId: c.o.id });
  }

  return transactions.map(t => {
    const found = info.get(t.id);
    if (found) return { ...t, ...found };
    if (HINT.test(t.description)) return { ...t, transfer: 'unmatched' };
    return t;
  });
}

export function transferSummary(transactions) {
  const count = k => transactions.filter(t => t.transfer === k).length;
  return { matched: count('matched'), suggested: count('suggested'), unmatched: count('unmatched') };
}
