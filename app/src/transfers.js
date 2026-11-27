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

const HINT = /payment|pymt|transfer|xfer|epayment|autopay|zelle|venmo|cash app|paypal|thank you|deposit|withdraw|contribution|\bach\b|wire|funds|moneylink|journal/i;
const GENERIC = new Set(['chase', 'bank', 'account', 'checking', 'checkings', 'savings', 'credit', 'card', 'the', 'and', 'high', 'yield']);
const MAX_DAYS = 5;
const CASH_OUT = /^VENMO TRANSFER TO BANK/;
const TXN_NO = /transaction\s*#\s*:?\s*(\d{6,})/i;

const dayNumber = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);

// accounts (optional): { [accountKey]: { name, last4, type } }. With it, a pair also counts as a transfer when one line names the other
// account (its last four digits, or a word of its name like JPMORGAN), or when one side is an investment or savings account
// (money only moves into those from your own accounts), and investment transfers may take a few more days to land.
export function matchTransfers(transactions, { maxDays = MAX_DAYS, accounts = {} } = {}) {
  const words = key => (accounts[key]?.name ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !GENERIC.has(w) && !/^\d+$/.test(w));
  const names = (t, other) => { const d = (t.description ?? '').toLowerCase(); const a = accounts[other]; return !!a && ((a.last4 && d.includes(a.last4)) || words(other).some(w => d.includes(w))); };
  const putAway = key => ['investment', 'savings'].includes(accounts[key]?.type);
  // Rows you entered by hand are not statement rows, so they never pair with one.
  const outs = transactions.filter(t => t.cents < 0 && !t.byHand);
  const ins = transactions.filter(t => t.cents > 0 && !t.byHand);

  // Every possible pairing: money out of one account, same amount into a DIFFERENT account, near in time.
  const candidates = [];
  for (const o of outs) {
    for (const i of ins) {
      if (o.account === i.account || o.cents !== -i.cents) continue;
      // A Venmo payment to or from a friend is not a transfer between your own accounts, even if a bank line has the same amount.
      // Only a cash-out from the Venmo balance can be one half of a transfer.
      if ((o.account === 'venmo' && !CASH_OUT.test(o.description)) || (i.account === 'venmo' && !CASH_OUT.test(i.description))) continue;
      const gap = Math.abs(dayNumber(o.date) - dayNumber(i.date));
      const invest = accounts[o.account]?.type === 'investment' || accounts[i.account]?.type === 'investment';
      if (gap > (invest ? maxDays + 3 : maxDays)) continue;
      const hinted = HINT.test(o.description) || HINT.test(i.description) || names(o, i.account) || names(i, o.account) || putAway(o.account) || putAway(i.account);
      candidates.push({ o, i, gap, hinted });
    }
  }
  // Best first: wording evidence, then closest dates. Each transaction can be used only once.
  candidates.sort((a, b) => (b.hinted - a.hinted) || (a.gap - b.gap));

  const used = new Set();
  const info = new Map(); // id -> { transfer, pairId }
  // Chase prints the same transaction number on both halves of a transfer ("... transaction#: 31092522089"). Two lines that
  // share one, with equal and opposite amounts, are the two halves, whatever account each landed in and however many days apart.
  const byNumber = new Map();
  for (const t of transactions) {
    const n = TXN_NO.exec(t.description ?? '')?.[1];
    if (n && !t.byHand) byNumber.set(n, [...(byNumber.get(n) ?? []), t]);
  }
  for (const [, pair] of byNumber) {
    if (pair.length !== 2 || pair[0].cents !== -pair[1].cents || pair[0].cents === 0) continue;
    const [a, b] = pair;
    used.add(a.id); used.add(b.id);
    info.set(a.id, { transfer: 'matched', pairId: b.id });
    info.set(b.id, { transfer: 'matched', pairId: a.id });
  }
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
