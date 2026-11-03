// Budget math. All money is integer cents. Weeks run Sunday -> Saturday.
//
//   free cash (monthly) = planned take-home - planned fixed - subscriptions - one-time and vacation set-asides - savings
//   daily target        = free cash / days in that month   (so a week spanning two months still works)
//   week target         = sum of the 7 daily targets
//   free spending       = everything in Free cash categories (refunds reduce it)
//                         + money-out still in "Needs review" (conservative: counted until you classify it)
//   effect on savings   = target - spending   (+ means you're adding to savings, - means you're pulling from it)
import { CATEGORIES } from './categories.js';

const PLANNED_GROUPS = new Set(['fixed', 'subscriptions', 'onetime', 'savings']);

const parse = iso => new Date(iso + 'T00:00:00Z');
const fmtIso = d => d.toISOString().slice(0, 10);
export const addDays = (iso, n) => { const d = parse(iso); d.setUTCDate(d.getUTCDate() + n); return fmtIso(d); };
export const startOfWeek = iso => addDays(iso, -parse(iso).getUTCDay()); // getUTCDay: Sunday = 0
export const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
export const monthOf = iso => iso.slice(0, 7);
export const daysInMonth = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

// plan = { income: cents per month (take-home), vacation: cents per month set aside for trips (optional),
//          planned: { categoryId: cents per month } }
export function validatePlan(plan) {
  if (!Number.isInteger(plan.income) || plan.income < 0) throw new Error('Plan income must be whole cents');
  if (plan.vacation != null && (!Number.isInteger(plan.vacation) || plan.vacation < 0)) throw new Error('Vacation set-aside must be whole cents');
  for (const [id, cents] of Object.entries(plan.planned ?? {})) {
    const cat = CATEGORIES[id];
    if (!cat) throw new Error(`Plan has unknown category "${id}"`);
    if (!PLANNED_GROUPS.has(cat.group)) {
      throw new Error(`"${cat.name}" can't be planned directly: free cash is whatever is left after fixed, subscriptions, one-time and savings`);
    }
    if (!Number.isInteger(cents) || cents < 0) throw new Error(`Plan amount for "${cat.name}" must be whole cents`);
  }
}

export function plannedFreeCash(plan) {
  validatePlan(plan);
  return plan.income - (plan.vacation ?? 0) - Object.values(plan.planned ?? {}).reduce((a, b) => a + b, 0);
}

export function targetForRange(plan, startIso, days) {
  const free = plannedFreeCash(plan);
  let total = 0;
  for (let i = 0; i < days; i++) total += free / daysInMonth(monthOf(addDays(startIso, i)));
  return Math.round(total);
}

// Counts toward free spending (positive number = money spent).
export function freeSpend(t) {
  const group = CATEGORIES[t.category].group;
  if (group === 'free') return -t.cents;
  if (t.category === 'review' && t.cents < 0) return -t.cents;
  return 0;
}

// `from`/`to` optionally clip the week (first week of data, or the week still in progress),
// so a half-finished week is compared with a half-sized target instead of looking like a win.
export function weekSummary(transactions, plan, weekStart, { from, to } = {}) {
  const end = addDays(weekStart, 6);
  const lo = from && from > weekStart ? from : weekStart;
  const hi = to && to < end ? to : end;
  const days = daysBetween(lo, hi) + 1;
  const inWeek = transactions.filter(t => t.date >= lo && t.date <= hi);
  const spent = inWeek.reduce((s, t) => s + freeSpend(t), 0);
  const target = targetForRange(plan, lo, days);
  const review = inWeek.filter(t => t.category === 'review' && t.cents < 0);
  return { weekStart, weekEnd: end, days, partial: days < 7, target, spent, effect: target - spent, needsReviewCount: review.length };
}

// One row per week from the first to the last transaction, with a running total of the effect on savings.
// The first and last weeks are clipped to the days we actually have data for.
export function weeklyRunning(transactions, plan) {
  if (!transactions.length) return [];
  const dates = transactions.map(t => t.date).sort();
  const first = dates[0], last = dates[dates.length - 1];
  const rows = [];
  let running = 0;
  for (let w = startOfWeek(first); w <= startOfWeek(last); w = addDays(w, 7)) {
    const row = weekSummary(transactions, plan, w, { from: first, to: last });
    running += row.effect;
    rows.push({ ...row, running });
  }
  return rows;
}

// Planned vs actual for one month ('YYYY-MM').
export function monthSummary(transactions, plan, ym) {
  const free = plannedFreeCash(plan);
  const inMonth = transactions.filter(t => monthOf(t.date) === ym);
  const sumGroup = (group, sign) => inMonth
    .filter(t => CATEGORIES[t.category].group === group)
    .reduce((s, t) => s + sign * t.cents, 0);
  const plannedOf = group => Object.entries(plan.planned ?? {})
    .filter(([id]) => CATEGORIES[id].group === group).reduce((s, [, c]) => s + c, 0);
  const spent = inMonth.reduce((s, t) => s + freeSpend(t), 0);
  return {
    month: ym,
    income: { planned: plan.income, actual: sumGroup('income', 1) },
    fixed: { planned: plannedOf('fixed'), actual: sumGroup('fixed', -1) },
    subscriptions: { planned: plannedOf('subscriptions'), actual: sumGroup('subscriptions', -1) },
    onetime: { planned: plannedOf('onetime'), actual: sumGroup('onetime', -1) },
    vacation: { planned: plan.vacation ?? 0, actual: sumGroup('vacation', -1) },
    savings: { planned: plannedOf('savings'), actual: sumGroup('savings', -1) },
    free: { planned: free, actual: spent, effect: free - spent },
    needsReviewCount: inMonth.filter(t => t.category === 'review' && t.cents < 0).length,
  };
}
