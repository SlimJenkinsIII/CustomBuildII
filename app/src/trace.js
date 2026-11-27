// Follow the money: where did a deposit (a bonus, a paycheck) actually go?
//
// Every dollar in your bank, savings, Venmo and investment accounts carries a tag saying where it came from: the money you started
// with, or the deposit that brought it in. When money leaves an account it uses up that account's dollars oldest first (FIFO) or
// newest first (LIFO). A transfer between your accounts carries the tags with it. Paying a credit card uses the tagged dollars to pay
// off the card's charges, oldest first, so a card payment is traced through to what was bought.
//
// All money is integer cents. Nothing is rounded: every trace adds up exactly to the deposit it follows.

const OPENING = 'opening';

// txs: the categorized transactions (account, date, cents, category, transfer, pairId, id, description).
// roles: account -> 'asset' | 'liability'. opening: { date, balances: { 'src:<account>': cents } }.
// sources: the ids of the deposits to follow. method: 'fifo' | 'lifo'. until: last date to follow to (optional).
export function traceCash(txs, { roles, opening = { date: '1900-01-01', balances: {} }, sources, method = 'fifo', until = '9999-12-31' }) {
  const follow = new Set(sources);
  const lots = new Map();                     // asset account -> [{ origin, cents }], oldest first
  const debts = new Map();                    // card -> [{ tx, cents }], oldest charge first
  const out = { spent: [], cards: [], transit: [], cardCredit: 0, moves: [] };
  const isAsset = a => (roles[a] ?? 'asset') === 'asset';
  const queue = (map, a) => { if (!map.has(a)) map.set(a, []); return map.get(a); };

  // what you started with
  for (const [key, cents] of Object.entries(opening.balances ?? {})) {
    const a = key.startsWith('src:') ? key.slice(4) : null;
    if (!a || !cents) continue;
    if (isAsset(a)) queue(lots, a).push({ origin: OPENING, cents });
    else queue(debts, a).push({ tx: { id: OPENING, account: a, description: 'Owed at the start', date: opening.date, category: null }, cents });
  }

  const take = (a, cents) => {
    const q = queue(lots, a), got = [];
    let need = cents;
    while (need > 0 && q.length) {
      const lot = method === 'lifo' ? q[q.length - 1] : q[0];
      const n = Math.min(need, lot.cents);
      got.push({ origin: lot.origin, cents: n });
      lot.cents -= n; need -= n;
      if (!lot.cents) { if (method === 'lifo') q.pop(); else q.shift(); }
    }
    if (need > 0) got.push({ origin: 'short', cents: need });       // the account went below what we know it had
    return got;
  };
  const put = (a, slices) => { const q = queue(lots, a); for (const s of slices) if (s.cents > 0) q.push({ ...s }); };
  const mine = slices => slices.filter(s => follow.has(s.origin)).reduce((n, s) => n + s.cents, 0);

  // paying a card: the dollars paid go to the oldest charges still owed
  const payCard = (card, slices, payTx) => {
    const q = queue(debts, card);
    for (const s of slices) {
      let left = s.cents;
      while (left > 0 && q.length) {
        const d = q[0], n = Math.min(left, d.cents);
        if (follow.has(s.origin)) out.cards.push({ card, charge: d.tx, cents: n, paidOn: payTx.date, payment: payTx });
        d.cents -= n; left -= n;
        if (!d.cents) q.shift();
      }
      if (left > 0 && follow.has(s.origin)) out.cardCredit += left;   // paid more than was owed: it sits on the card as a credit
    }
  };

  const ledger = txs.filter(t => t.date > (opening.date ?? '') && t.date <= until && t.cents !== 0)
    // by date; on the same day, money in before money out
    .sort((a, b) => a.date.localeCompare(b.date) || (b.cents > 0) - (a.cents > 0));
  const byId = new Map(txs.map(t => [t.id, t]));
  const done = new Set();

  for (const t of ledger) {
    if (done.has(t.id)) continue;
    const pair = t.transfer === 'matched' && t.pairId ? byId.get(t.pairId) : null;
    if (pair) {
      // a transfer between your own accounts: handled once, on whichever half comes first
      done.add(t.id); done.add(pair.id);
      const from = t.cents < 0 ? t : pair, to = t.cents < 0 ? pair : t;
      const cents = Math.min(-from.cents, to.cents);                  // a fee taken on the way is booked on its own line
      let slices;
      if (isAsset(from.account)) slices = take(from.account, cents);
      else { queue(debts, from.account).push({ tx: from, cents }); slices = [{ origin: `card:${from.id}`, cents }]; }   // a card paid for it
      if (isAsset(to.account)) {
        put(to.account, slices);
        const m = mine(slices); if (m) out.moves.push({ from: from.account, to: to.account, date: to.date, cents: m });
      } else payCard(to.account, slices, from);
      continue;
    }
    done.add(t.id);
    if (isAsset(t.account)) {
      if (t.cents > 0) { put(t.account, [{ origin: t.id, cents: t.cents }]); continue; }       // money arriving from outside
      const slices = take(t.account, -t.cents);
      const m = mine(slices);
      if (!m) continue;
      if (t.category === 'transfer') out.transit.push({ tx: t, cents: m });   // a transfer whose other half isn't imported
      else out.spent.push({ tx: t, cents: m });
    } else if (t.cents < 0) {
      queue(debts, t.account).push({ tx: t, cents: -t.cents });                                   // a card charge
    } else {
      // a refund or an unmatched payment on a card: it pays off the oldest charges, with money we don't follow
      payCard(t.account, [{ origin: 'other', cents: t.cents }], t);
    }
  }

  const held = [...lots].map(([account, q]) => ({ account, cents: q.filter(l => follow.has(l.origin)).reduce((n, l) => n + l.cents, 0) })).filter(x => x.cents > 0);
  const total = txs.filter(t => follow.has(t.id)).reduce((n, t) => n + t.cents, 0);
  const sum = a => a.reduce((n, x) => n + x.cents, 0);
  return { total, method, held, spent: out.spent, cards: out.cards, transit: out.transit, cardCredit: out.cardCredit, moves: out.moves,
    totals: { held: sum(held), spent: sum(out.spent), cards: sum(out.cards), transit: sum(out.transit), cardCredit: out.cardCredit } };
}

// Deposits worth following: money that came into a bank, savings or Venmo account from outside (not a transfer between your accounts).
export const deposits = (txs, roles, openingDate = '') => txs
  .filter(t => t.cents > 0 && (roles[t.account] ?? 'asset') === 'asset' && t.category !== 'transfer' && t.transfer !== 'matched' && t.date > openingDate)
  .sort((a, b) => b.date.localeCompare(a.date) || b.cents - a.cents);
