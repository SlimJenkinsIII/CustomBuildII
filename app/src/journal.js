// The ledger behind the trial balance and the tie-out.
//
// Every transaction becomes a balanced entry, debits = credits:
//   money INTO a statement account is a debit to it, money OUT is a credit (cards work the same way, so a
//   charge is a credit that raises what you owe and a payment is a debit that lowers it);
//   the other side is the GL account the transaction was filed under (income credited, spending debited,
//   a move into savings debited to that savings account, anything unclassified to suspense).
// A payment between two of your own accounts is one entry between the two. If its two halves land in
// different months, "transfers in transit" holds the difference so every month still balances.
import { CATEGORIES, SOURCE_ACCOUNTS, SOURCE_ROLES, SYSTEM_ACCOUNTS, classOf } from './categories.js';
import { monthOf, daysInMonth, plannedFreeCash } from './budget.js';

const SUSPENSE = 'review';
const srcKey = account => `src:${account}`;

export function accountInfo(key) {
  if (key.startsWith('src:')) {
    const a = SOURCE_ACCOUNTS[key.slice(4)];
    return a ? { key, code: a.code, name: a.name } : { key, code: '1999', name: key.slice(4) };
  }
  const sys = SYSTEM_ACCOUNTS.find(a => a.key === key);
  if (sys) return { key, code: sys.code, name: sys.name };
  const c = CATEGORIES[key];
  return { key, code: c.code, name: c.name, group: c.group };
}

const neg = x => (x === 0 ? 0 : -x);                                   // never -0
const dr = (key, cents) => ({ key, debit: cents, credit: 0 });
const cr = (key, cents) => ({ key, debit: 0, credit: cents });
const side = (key, cents) => (cents > 0 ? dr(key, cents) : cr(key, -cents));

export function buildJournal(txs) {
  const byId = new Map(txs.map(t => [t.id, t]));
  const used = new Set();
  const entries = [];
  for (const t of txs) {
    if (used.has(t.id)) continue;
    used.add(t.id);
    const mine = side(srcKey(t.account), t.cents);
    if (t.category === 'transfer') {
      const other = t.pairId ? byId.get(t.pairId) : null;
      if (other && other.category === 'transfer' && !used.has(other.id) && other.cents === -t.cents) {
        used.add(other.id);
        const theirs = side(srcKey(other.account), other.cents);
        if (monthOf(t.date) === monthOf(other.date)) {
          entries.push({ date: t.date, memo: t.description, txIds: [t.id, other.id], lines: [mine, theirs] });
        } else {
          // each half is balanced against transfers in transit, so each month still balances
          entries.push({ date: t.date, memo: t.description, txIds: [t.id], lines: [mine, side('clearing', -t.cents)] });
          entries.push({ date: other.date, memo: other.description, txIds: [other.id], lines: [theirs, side('clearing', -other.cents)] });
        }
        continue;
      }
    }
    const offsetKey = t.category === 'transfer' ? SUSPENSE : t.category;   // a lone transfer row has no other half
    entries.push({ date: t.date, memo: t.description, txIds: [t.id], lines: [mine, side(offsetKey, -t.cents)] });
  }
  return entries;
}

export const totalsOf = entries => entries.reduce((s, e) => e.lines.reduce((a, l) => ({ debit: a.debit + l.debit, credit: a.credit + l.credit }), s), { debit: 0, credit: 0 });

// ---------- opening balances ----------
// The books start on a date with a balance in each account you have or owe. Anything dated on or before
// that day is "before the books" and is left out of the ledger views. The difference between what you
// have and what you owe is held in opening balance equity, so the books balance from day one.
export const NO_OPENING = { date: '1900-01-01', balances: {} };
export const DEFAULT_OPENING_DATE = '2024-12-31';

// The accounts you can enter an opening balance for, assets first. Amounts are entered as they read on a
// statement: what you have in an asset account, what you owe on a card.
export function openingAccounts() {
  const sources = Object.keys(SOURCE_ACCOUNTS).map(a => ({ key: `src:${a}`, side: SOURCE_ROLES[a] ?? 'asset' }));
  const savings = Object.values(CATEGORIES).filter(c => c.group === 'savings').sort((a, b) => a.code.localeCompare(b.code))
    .map(c => ({ key: c.id, side: 'asset' }));
  return [...sources.filter(a => a.side === 'asset'), ...savings, ...sources.filter(a => a.side === 'liability')]
    .map(a => ({ ...a, ...accountInfo(a.key) }));
}

// Keeps a saved opening only if it is well formed.
export function cleanOpening(raw) {
  const out = { date: DEFAULT_OPENING_DATE, balances: {} };
  if (!raw || typeof raw !== 'object') return out;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.date) && !Number.isNaN(Date.parse(raw.date + 'T00:00:00Z'))) out.date = raw.date;
  const known = new Set(openingAccounts().map(a => a.key));
  for (const [key, cents] of Object.entries(raw.balances ?? {})) {
    if (known.has(key) && Number.isInteger(cents) && cents > 0) out.balances[key] = cents;
  }
  return out;
}

export function openingEntry(opening) {
  const lines = [];
  for (const a of openingAccounts()) {
    const cents = opening.balances?.[a.key] ?? 0;
    if (cents > 0) lines.push(a.side === 'asset' ? dr(a.key, cents) : cr(a.key, cents));
  }
  if (!lines.length) return null;
  const t = totalsOf([{ lines }]);
  lines.push(t.debit >= t.credit ? cr('equity', t.debit - t.credit) : dr('equity', t.credit - t.debit));
  return { date: opening.date, memo: 'Opening balances', txIds: [], lines, opening: true };
}

export const countBeforeOpening = (txs, opening) => txs.filter(t => t.date <= opening.date).length;

// Only income, spending and other income/loss reset each year; everything else carries forward.
const PNL_GROUPS = new Set(['income', 'fixed', 'subscriptions', 'onetime', 'free', 'vacation', 'other']);
// Needs review is an expense account: what is still unsorted counts in net income (money out as expense, money in as contra-expense).
const isPnl = key => !key.startsWith('src:') && (PNL_GROUPS.has(CATEGORIES[key]?.group) || key === SUSPENSE);

// Which part of the statements an account belongs to. Decided by what the account is, never by its number.
export function sectionOf(key) {
  if (key.startsWith('src:')) return SOURCE_ROLES[key.slice(4)] === 'liability' ? 'liability' : 'asset';
  if (key === 'equity' || key === 'retained') return 'equity';
  if (key === 'clearing') return 'asset';
  return isPnl(key) ? 'pnl' : 'asset';           // savings accounts are things you have
}

// ---------- trial balance ----------
// One row per account that has activity, in account-number order. Each month column is that account's
// net movement (debits positive, credits negative). Every column adds to zero.
export function trialBalance(txs, year, asOf = '', opening = NO_OPENING) {
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const firstOfYear = `${year}-01`;
  const startDate = `${Number(year) - 1}-12-31`;
  const journal = buildJournal(txs).filter(e => e.date > opening.date);       // before the books started: left out
  const oe = openingEntry(opening);

  // movement per account per month, over all time (running balances need the earlier years too)
  const act = new Map(), opn = new Map();
  for (const e of journal) for (const l of e.lines) {
    const m = act.get(l.key) ?? new Map();
    m.set(monthOf(e.date), (m.get(monthOf(e.date)) ?? 0) + l.debit - l.credit);
    act.set(l.key, m);
  }
  if (oe) for (const l of oe.lines) opn.set(l.key, (opn.get(l.key) ?? 0) + l.debit - l.credit);
  const sumAct = (key, pred) => [...(act.get(key) ?? new Map())].reduce((s, [ym, v]) => (pred(ym) ? s + v : s), 0);

  const lastData = txs.reduce((m, t) => (t.date > m ? t.date : m), '');
  const asOfDate = asOf || lastData;
  const asOfMonth = asOfDate ? monthOf(asOfDate) : '';
  const hasData = Object.fromEntries(months.map(ym => [ym, journal.some(e => monthOf(e.date) === ym)]));
  const reached = Object.fromEntries(months.map(ym => [ym, !!asOfMonth && ym >= monthOf(opening.date) && ym <= asOfMonth]));
  const partialMonth = asOf && hasData[asOfMonth] && Number(asOf.slice(8)) < daysInMonth(asOfMonth) ? asOfMonth : null;
  const openDate = opening.date > startDate ? opening.date : startDate;

  const keys = new Set([...act.keys(), ...opn.keys()]);
  const pnlKeys = [...keys].filter(isPnl);
  // last year's income and spending is closed into retained earnings on January 1
  const closed = pnlKeys.reduce((s, k) => s + sumAct(k, ym => ym < firstOfYear), 0);
  if (closed !== 0) keys.add('retained');

  const balanceAt = (key, ym) => {
    if (key === 'retained') return closed;
    if (isPnl(key)) return sumAct(key, m => m >= firstOfYear && m <= ym);
    return (opn.get(key) ?? 0) + sumAct(key, m => m <= ym);
  };
  const openBalance = key => (key === 'retained' ? closed : isPnl(key) ? 0 : (opn.get(key) ?? 0) + sumAct(key, m => m < firstOfYear));

  const zero = () => Object.fromEntries(months.map(ym => [ym, 0]));
  const rows = [...keys].map(key => {
    const info = accountInfo(key);
    const byMonth = zero(), balByMonth = zero();
    for (const ym of months) {
      byMonth[ym] = act.get(key)?.get(ym) ?? 0;
      balByMonth[ym] = reached[ym] ? balanceAt(key, ym) : 0;
    }
    const total = months.reduce((s, ym) => s + byMonth[ym], 0);
    const openBal = Number(year) >= Number(opening.date.slice(0, 4)) ? openBalance(key) : 0;
    const lastReached = [...months].reverse().find(ym => reached[ym]);
    return { ...info, class: classOf(info.code), section: sectionOf(key), byMonth, total, balByMonth, openBal, change: lastReached ? balByMonth[lastReached] - openBal : 0 };
  }).filter(r => r.openBal !== 0 || r.total !== 0 || months.some(ym => r.byMonth[ym] !== 0 || r.balByMonth[ym] !== 0))
    .sort((a, b) => a.code.localeCompare(b.code) || a.name.localeCompare(b.name));

  const split = values => ({ debit: values.reduce((s, v) => s + Math.max(v, 0), 0), credit: values.reduce((s, v) => s + Math.max(-v, 0), 0) });
  const withDiff = t => ({ ...t, difference: t.debit - t.credit });
  const col = pick => Object.fromEntries(months.map(ym => [ym, withDiff(split(rows.map(r => pick(r, ym))))]));
  const act2 = col((r, ym) => r.byMonth[ym]);
  const sumOver = field => months.reduce((s, ym) => s + act2[ym][field], 0);
  const pnlRows = rows.filter(r => r.key !== 'retained' && isPnl(r.key));

  return {
    year, months, hasData, reached, partialMonth, openDate, hasOpening: !!oe, rows,
    // activity: each month's movement
    totals: {
      debit: Object.fromEntries(months.map(ym => [ym, act2[ym].debit])),
      credit: Object.fromEntries(months.map(ym => [ym, act2[ym].credit])),
      difference: Object.fromEntries(months.map(ym => [ym, act2[ym].difference])),
      debitYtd: sumOver('debit'), creditYtd: sumOver('credit'), differenceYtd: sumOver('difference'),
    },
    netIncome: {
      byMonth: Object.fromEntries(months.map(ym => [ym, -pnlRows.reduce((s, r) => s + r.byMonth[ym], 0)])),
      total: -pnlRows.reduce((s, r) => s + r.total, 0),
    },
    // balances: where every account stands at the start of the year and at the end of each month
    bal: {
      open: withDiff(split(rows.map(r => r.openBal))),
      byMonth: Object.fromEntries(months.map(ym => [ym, reached[ym] ? withDiff(split(rows.map(r => r.balByMonth[ym]))) : withDiff({ debit: 0, credit: 0 })])),
    },
    netIncomeYtd: Object.fromEntries(months.map(ym => [ym, reached[ym] ? -pnlRows.reduce((s, r) => s + r.balByMonth[ym], 0) : 0])),
  };
}

// ---------- tie-out: where did the cash go? ----------
// Cash here is your checking account, the one cash account with statements. For a month, or the year to
// date, this explains the change in checking from everything else in the ledger, then lines the same
// movement up against your plan.
const CASH_GROUPS = ['fixed', 'subscriptions', 'free', 'onetime', 'vacation'];

export function tieOut(txs, plan, period, asOf = '', opening = NO_OPENING) {
  const allMonths = [...new Set(txs.filter(t => t.date > opening.date).map(t => monthOf(t.date)))].sort();
  const wanted = period.kind === 'month' ? [period.ym] : allMonths.filter(ym => ym.startsWith(period.year + '-'));
  const inPeriod = new Set(wanted);
  const entries = buildJournal(txs).filter(e => e.date > opening.date && inPeriod.has(monthOf(e.date)));

  const net = new Map(), debit = new Map(), credit = new Map();
  for (const e of entries) for (const l of e.lines) {
    net.set(l.key, (net.get(l.key) ?? 0) + l.debit - l.credit);
    debit.set(l.key, (debit.get(l.key) ?? 0) + l.debit);
    credit.set(l.key, (credit.get(l.key) ?? 0) + l.credit);
  }
  const get = (m, k) => m.get(k) ?? 0;
  const keysIn = (...groups) => [...net.keys()].filter(k => !k.startsWith('src:') && k !== 'clearing' && groups.includes(CATEGORIES[k]?.group));
  const groupNet = (...groups) => keysIn(...groups).reduce((s, k) => s + get(net, k), 0);

  // cash effect of each part of the ledger (positive adds to checking, negative takes from it)
  const effect = {
    income: neg(groupNet('income')),
    other: neg(groupNet('other')),
    fixed: neg(groupNet('fixed')), subscriptions: neg(groupNet('subscriptions')), free: neg(groupNet('free')),
    onetime: neg(groupNet('onetime')), vacation: neg(groupNet('vacation')),
    review: neg(get(net, SUSPENSE)),
  };
  const netIncome = Object.values(effect).reduce((a, b) => a + b, 0);
  const savingsKeys = Object.values(CATEGORIES).filter(c => c.group === 'savings' && (net.has(c.id))).map(c => c.id);
  const savings = savingsKeys.map(id => ({
    id, name: CATEGORIES[id].name, code: CATEGORIES[id].code,
    movedIn: get(debit, id), pulledOut: get(credit, id), net: get(net, id),
  }));
  const savingsNet = savings.reduce((s, a) => s + a.net, 0);          // positive = moved into savings
  const cards = Object.keys(SOURCE_ACCOUNTS).filter(a => SOURCE_ROLES[a] === 'liability').map(srcKey);
  const float = neg(cards.reduce((s, k) => s + get(net, k), 0));           // owed on cards, not yet paid out of checking
  const clearing = neg(get(net, 'clearing'));                              // transfers sent but not yet received (or the reverse)
  const cashChange = netIncome - savingsNet + float + clearing;
  const checking = Object.keys(SOURCE_ACCOUNTS).filter(a => SOURCE_ROLES[a] === 'asset').map(srcKey).reduce((s, k) => s + get(net, k), 0);

  // plan, scaled for the months in the period (a month still in progress counts for the days elapsed)
  const asOfMonth = asOf ? monthOf(asOf) : '';
  const factor = wanted.reduce((s, ym) => s + (ym === asOfMonth && Number(asOf.slice(8)) < daysInMonth(ym) ? Number(asOf.slice(8)) / daysInMonth(ym) : 1), 0);
  const plannedIn = g => Object.entries(plan.planned ?? {}).filter(([id]) => CATEGORIES[id].group === g).reduce((s, [, c]) => s + c, 0);
  const P = {
    income: plan.income, fixed: plannedIn('fixed'), subscriptions: plannedIn('subscriptions'), onetime: plannedIn('onetime'),
    vacation: plan.vacation ?? 0, savings: plannedIn('savings'), free: plannedFreeCash(plan),
  };
  const scaled = k => Math.round(P[k] * factor);
  // free cash is whatever is left of the scaled plan, exactly, so the plan itself adds to zero
  const planned = k => (k === 'free'
    ? scaled('income') - ['fixed', 'subscriptions', 'onetime', 'vacation', 'savings'].reduce((s, g) => s + scaled(g), 0)
    : scaled(k));
  const line = (label, plannedAmt, actual, sign) => ({ label, planned: plannedAmt, actual, effect: sign * (actual - plannedAmt) });
  const spend = k => neg(effect[k]);                                   // money spent, shown positive
  const vsPlan = [
    line('Take-home pay', planned('income'), effect.income, 1),
    line('Fixed bills', planned('fixed'), spend('fixed'), -1),
    line('Subscriptions', planned('subscriptions'), spend('subscriptions'), -1),
    line('One-time & annual', planned('onetime'), spend('onetime'), -1),
    line('Vacations', planned('vacation'), spend('vacation'), -1),
    line('Free cash spending', planned('free'), spend('free'), -1),
    line('Moved to savings', planned('savings'), savingsNet, -1),
    { label: 'Interest, fees & other', planned: 0, actual: effect.other, effect: effect.other },
    { label: 'Needs review', planned: 0, actual: neg(effect.review), effect: effect.review },
    { label: float >= 0 ? 'Card charges not yet paid' : 'Paid down earlier card balances', planned: 0, actual: float, effect: float },
    ...(clearing ? [{ label: 'Transfers in transit', planned: 0, actual: clearing, effect: clearing }] : []),
  ];
  const free = { planned: planned('free'), actual: spend('free') };
  const over = Math.max(0, free.actual - free.planned);
  const pulledOut = savings.reduce((s, a) => s + a.pulledOut, 0);
  return {
    period, months: wanted, factor,
    effect, netIncome, savings, savingsNet, float, clearing, cashChange, checking, ties: cashChange === checking,
    vsPlan, vsPlanTotal: vsPlan.reduce((s, l) => s + l.effect, 0),
    overspend: { over, free, pulledOut, movedLess: Math.max(0, planned('savings') - savingsNet) },
  };
}

// ---------- balance sheet ----------
// What you have, what you owe, and what is left, at the start of the year and at the end of each month.
// Liabilities and equity are credit balances, shown as positive numbers, so the sheet reads
// assets = liabilities + equity. Equity includes this year's earnings so far (income less spending, year to date).
export function balanceSheet(txs, year, asOf = '', opening = NO_OPENING) {
  const tb = trialBalance(txs, year, asOf, opening);
  const { months, reached } = tb;
  const sign = r => (r.section === 'asset' ? 1 : -1);
  const make = r => ({
    key: r.key, code: r.code, name: r.name, open: sign(r) * r.openBal,
    byMonth: Object.fromEntries(months.map(ym => [ym, reached[ym] ? sign(r) * r.balByMonth[ym] : 0])),
  });
  const total = rows => ({
    open: rows.reduce((s, r) => s + r.open, 0),
    byMonth: Object.fromEntries(months.map(ym => [ym, rows.reduce((s, r) => s + r.byMonth[ym], 0)])),
  });
  const section = name => { const rows = tb.rows.filter(r => r.section === name).map(make); return { rows, ...total(rows) }; };

  const assets = section('asset'), liabilities = section('liability'), equityAccounts = section('equity');
  const earnings = { open: 0, byMonth: Object.fromEntries(months.map(ym => [ym, tb.netIncomeYtd[ym]])) };
  const add = (a, b) => ({ open: a.open + b.open, byMonth: Object.fromEntries(months.map(ym => [ym, a.byMonth[ym] + b.byMonth[ym]])) });
  const equity = { rows: equityAccounts.rows, earnings, ...add(equityAccounts, earnings) };
  const liabilitiesAndEquity = add(liabilities, equity);
  const difference = {
    open: assets.open - liabilitiesAndEquity.open,
    byMonth: Object.fromEntries(months.map(ym => [ym, assets.byMonth[ym] - liabilitiesAndEquity.byMonth[ym]])),
  };
  return { year, months, reached, partialMonth: tb.partialMonth, openDate: tb.openDate, hasOpening: tb.hasOpening, assets, liabilities, equity, liabilitiesAndEquity, difference };
}
