// Numbers behind the spending hub. Pure functions: transactions + plan in, plain facts out.
import { CATEGORIES } from './categories.js';
import { freeSpend, monthOf, daysInMonth, daysBetween, plannedFreeCash } from './budget.js';

export const asOfDate = txs => txs.reduce((m, t) => (t.date > m ? t.date : m), '');

// Where free-cash money went between two dates (inclusive), biggest first. Refunds net against their category.
export function categoryBreakdownRange(txs, from, to) {
  const by = new Map();
  for (const t of txs) {
    if (t.date < from || t.date > to) continue;
    const spent = freeSpend(t);
    if (!spent) continue;
    const row = by.get(t.category) ?? { id: t.category, name: CATEGORIES[t.category].name, cents: 0, count: 0 };
    row.cents += spent; row.count += 1;
    by.set(t.category, row);
  }
  const rows = [...by.values()].filter(r => r.cents > 0).sort((a, b) => b.cents - a.cents);
  const total = rows.reduce((s, r) => s + r.cents, 0);
  return { total, rows: rows.map(r => ({ ...r, share: total ? r.cents / total : 0 })) };
}
export const categoryBreakdown = (txs, ym) => categoryBreakdownRange(txs, `${ym}-01`, `${ym}-31`);

// How a month is going. Projection is a straight-line guess, so it only means something a week in.
export function monthPace(txs, plan, ym, asOf) {
  const free = plannedFreeCash(plan);
  const spent = txs.filter(t => monthOf(t.date) === ym).reduce((s, t) => s + freeSpend(t), 0);
  const dim = daysInMonth(ym);
  const asOfMonth = monthOf(asOf);
  const elapsed = asOfMonth > ym ? dim : asOfMonth < ym ? 0 : Number(asOf.slice(8));
  const complete = elapsed === dim;
  const projected = complete ? spent : elapsed ? Math.round(spent / elapsed * dim) : 0;
  return { free, spent, left: free - spent, elapsed, dim, complete, projected, projectedEffect: free - projected };
}

export function topPurchasesRange(txs, from, to, n = 3) {
  return txs
    .filter(t => t.date >= from && t.date <= to && t.cents < 0 && (CATEGORIES[t.category].group === 'free' || t.category === 'review'))
    .sort((a, b) => a.cents - b.cents).slice(0, n);
}
export const topPurchases = (txs, ym, n = 3) => topPurchasesRange(txs, `${ym}-01`, `${ym}-31`, n);

const DINING = new Set(['free_restaurants', 'free_coffee', 'free_alcohol']);
export function diningOutRange(txs, from, to) {
  const dining = txs.filter(t => t.date >= from && t.date <= to && DINING.has(t.category)).reduce((s, t) => s + freeSpend(t), 0);
  const { total } = categoryBreakdownRange(txs, from, to);
  return { cents: dining, share: total ? dining / total : 0 };
}
export const diningOut = (txs, ym) => diningOutRange(txs, `${ym}-01`, `${ym}-31`);

// Streaks and extremes from the weekly rows. Weeks with under 3 days of data are too thin to judge.
export function habits(rows) {
  const judged = rows.filter(r => r.days >= 3);
  const under = judged.filter(r => r.effect >= 0);
  let streak = 0;
  for (let i = judged.length - 1; i >= 0 && judged[i].effect >= 0; i--) streak++;
  const byEffect = [...judged].sort((a, b) => b.effect - a.effect);
  return {
    weeks: judged.length, under: under.length, over: judged.length - under.length, streak,
    best: byEffect[0], worst: byEffect[byEffect.length - 1],
  };
}

export function attention(txs) {
  const review = txs.filter(t => t.category === 'review' && t.cents < 0);
  return {
    review: { count: review.length, cents: -review.reduce((s, t) => s + t.cents, 0) },
    unmatched: txs.filter(t => t.transfer === 'unmatched').length,
    reimbursements: txs.filter(t => t.askReimbursement),
  };
}

// What dates each account's data covers, so a stale statement doesn't quietly look like low spending.
export function coverage(txs) {
  const by = new Map();
  for (const t of txs) {
    const r = by.get(t.account) ?? { account: t.account, from: t.date, to: t.date, count: 0 };
    if (t.date < r.from) r.from = t.date;
    if (t.date > r.to) r.to = t.date;
    r.count++;
    by.set(t.account, r);
  }
  return [...by.values()].sort((a, b) => a.account.localeCompare(b.account));
}


// ---------- month-by-month table ----------
// Laid out like a small P&L, in GL-code order:
//   4000 income  and  5100-5499 operating expenses            -> Net operating income
//   6000s other income & loss (interest, gains, one-time purchases, annual fees)  and  7000 vacations
//                                                              -> Net income (loss)
//   then money moved into savings and investing (asset accounts) -> Left after savings moved
// Operating lines show money spent as a positive number. Below the operating line, amounts keep their
// natural sign (income positive, losses and spending in brackets) so each total simply adds up.
// Transfers between your own accounts are left out. "Needs review" is its own line, like a suspense account.
const NATURAL_SIGN = new Set(['income', 'other', 'onetime', 'vacation']);

export function monthlyMatrix(txs, year, asOf = '') {
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const inYear = txs.filter(t => t.date.startsWith(year + '-'));
  const hasData = Object.fromEntries(months.map(ym => [ym, inYear.some(t => monthOf(t.date) === ym)]));
  const dataMonths = months.filter(ym => hasData[ym]).length;
  // A month still in progress is shown but kept out of averages, so it can't look like a low month.
  const asOfMonth = asOf ? monthOf(asOf) : '';
  const partialMonth = hasData[asOfMonth] && Number(asOf.slice(8)) < daysInMonth(asOfMonth) ? asOfMonth : null;
  const fullMonths = months.filter(ym => hasData[ym] && ym !== partialMonth);
  const avgMonths = fullMonths.length ? fullMonths : months.filter(ym => hasData[ym]);

  const acct = new Map(); // category id -> { byMonth, count }
  for (const t of inYear) {
    if (t.category === 'transfer') continue;
    const natural = NATURAL_SIGN.has(CATEGORIES[t.category].group);
    const a = acct.get(t.category) ?? { byMonth: {}, count: 0 };
    const ym = monthOf(t.date);
    a.byMonth[ym] = (a.byMonth[ym] ?? 0) + (natural ? t.cents : -t.cents);
    a.count++;
    acct.set(t.category, a);
  }

  const zero = () => Object.fromEntries(months.map(ym => [ym, 0]));
  const add = (a, b, sign = 1) => Object.fromEntries(months.map(ym => [ym, (a[ym] ?? 0) + sign * (b[ym] ?? 0)]));
  const finish = byMonth => {
    const total = months.reduce((s, ym) => s + (byMonth[ym] ?? 0), 0);
    const avgTotal = avgMonths.reduce((s, ym) => s + (byMonth[ym] ?? 0), 0);
    return { byMonth: { ...zero(), ...byMonth }, total, avg: avgMonths.length ? Math.round(avgTotal / avgMonths.length) : 0 };
  };

  const lines = [];
  // The header shows the hundreds the accounts below it span, e.g. 5100\u20135199.
  const codeRange = rows => {
    const nums = rows.map(r => Number(r.code));
    return `${Math.floor(Math.min(...nums) / 100) * 100}\u2013${Math.floor(Math.max(...nums) / 100) * 100 + 99}`;
  };
  const idsIn = (...groups) => Object.values(CATEGORIES)
    .filter(c => groups.includes(c.group)).sort((a, b) => a.code.localeCompare(b.code)).map(c => c.id);
  // One block of accounts with a header and a subtotal; returns the subtotal by month (zeros if empty).
  const section = (label, ids, subtotalLabel) => {
    const rows = ids.filter(id => acct.has(id)).map(id => ({
      kind: 'row', id, code: CATEGORIES[id].code, name: CATEGORIES[id].name, group: CATEGORIES[id].group, ...finish(acct.get(id).byMonth),
    }));
    const sum = rows.reduce((by, r) => add(by, r.byMonth), zero());
    if (rows.length) lines.push({ kind: 'header', code: codeRange(rows), label }, ...rows, { kind: 'subtotal', label: subtotalLabel, ...finish(sum) });
    return sum;
  };
  const net = (label, byMonth) => lines.push({ kind: 'net', label, ...finish(byMonth) });

  const income = section('Income', idsIn('income'), 'Total income');
  const fixed = section('Fixed monthly expenses', idsIn('fixed'), 'Total fixed monthly expenses');
  const subs = section('Subscriptions', idsIn('subscriptions'), 'Total subscriptions');
  const free = section('Free cash', idsIn('free'), 'Total free cash');
  const reviewBy = acct.has('review') ? acct.get('review').byMonth : {};
  if (acct.has('review')) {
    lines.push({ kind: 'row', id: 'review', code: CATEGORIES.review.code, name: 'Needs review (net)', group: 'review', ...finish(reviewBy) });
  }
  const review = { ...zero(), ...reviewBy };

  const operating = [fixed, subs, free, review].reduce((by, t) => add(by, t), zero());
  const netOperating = add(income, operating, -1);
  net('Net operating income', netOperating);

  const other = section('Other income & loss', idsIn('other', 'onetime'), 'Total other income & loss');
  const vacation = section('Vacations', idsIn('vacation'), 'Total vacations');
  const netIncome = add(add(netOperating, other), vacation);
  net('Net income (loss)', netIncome);

  const savings = section('Savings & investing moved (asset accounts)', idsIn('savings'), 'Total savings & investing moved');
  net('Left after savings moved', add(netIncome, savings, -1));

  // Running total of net income through the year (blank for months with no data yet).
  let run = 0;
  const lastData = [...months].reverse().find(ym => hasData[ym]);
  const cumulative = {};
  for (const ym of months) {
    run += netIncome[ym];
    cumulative[ym] = lastData && ym <= lastData ? run : null;
  }
  lines.push({ kind: 'running', label: 'Running total, net income', byMonth: cumulative });

  return { year, months, hasData, dataMonths, partialMonth, fullMonthCount: fullMonths.length, lines };
}

// ---------- looking back over a stretch of weeks ----------
// Only full Sunday-to-Saturday weeks are compared, so a week still in progress (or cut short by where your
// data starts) can't pass for a cheap one.
export const completeWeeks = rows => rows.filter(r => r.days === 7);

// The weeks in a period, plus the same number of weeks just before it (to compare against).
export function periodWindow(complete, kind) {
  const n = { '4w': 4, '8w': 8, '12w': 12 }[kind];
  if (n) {
    const rows = complete.slice(-n);
    const before = complete.slice(0, complete.length - rows.length).slice(-n);
    return { rows, prev: before.length === rows.length ? before : [] };
  }
  const year = complete.length ? complete[complete.length - 1].weekStart.slice(0, 4) : '';
  return { rows: complete.filter(r => r.weekStart >= `${year}-01-01`), prev: [] };      // year to date: no "before" to compare
}

export function periodTotals(rows) {
  const sum = k => rows.reduce((s, r) => s + r[k], 0);
  const byEffect = [...rows].sort((a, b) => b.effect - a.effect);
  return {
    weeks: rows.length, spent: sum('spent'), target: sum('target'), effect: sum('effect'),
    under: rows.filter(r => r.effect >= 0).length, over: rows.filter(r => r.effect < 0).length,
    avgSpent: rows.length ? Math.round(sum('spent') / rows.length) : 0,
    avgTarget: rows.length ? Math.round(sum('target') / rows.length) : 0,
    best: byEffect[0] ?? null, worst: byEffect[byEffect.length - 1] ?? null,
    from: rows[0]?.weekStart ?? null, to: rows.length ? rows[rows.length - 1].weekEnd : null,
  };
}

export function compareTotals(cur, prev) {
  if (!prev || !prev.weeks) return null;
  const delta = cur.spent - prev.spent;
  return { spentDelta: delta, pct: prev.spent ? delta / prev.spent : null, effectDelta: cur.effect - prev.effect };
}

// Running total of the effect on savings, week by week.
export function cumulativeSeries(rows) {
  let running = 0;
  return rows.map(r => ({ weekStart: r.weekStart, weekEnd: r.weekEnd, spent: r.spent, target: r.target, effect: r.effect, running: (running += r.effect) }));
}

// Accounts whose statements stop well before the others', so the latest days can look lighter than they were.
export function staleAccounts(txs, gapDays = 4) {
  const cov = coverage(txs);
  if (cov.length < 2) return [];
  const latest = cov.reduce((m, c) => (c.to > m ? c.to : m), '');
  return cov.map(c => ({ account: c.account, to: c.to, behind: daysBetween(c.to, latest) })).filter(c => c.behind >= gapDays);
}

// The month to review first: the latest one that is over, else the latest there is.
export function defaultMonth(txs) {
  const months = [...new Set(txs.map(t => monthOf(t.date)))].sort();
  if (!months.length) return null;
  const asOf = asOfDate(txs), asOfMonth = monthOf(asOf);
  const finished = months.filter(ym => ym < asOfMonth || Number(asOf.slice(8)) === daysInMonth(ym));
  return finished[finished.length - 1] ?? months[months.length - 1];
}
