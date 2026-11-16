// Phase 1 of the budget: what you earn, and what is paid to you first (your 401(k)) before anything reaches the bank.
// You enter one ordinary paystub once. Every paycheck deposit after that is read against it:
//   - about the usual take-home            -> a normal paycheck
//   - noticeably more                      -> a normal paycheck plus a bonus (or extra pay), backed into from the take-home rate
//   - more, after the 401(k) yearly limit  -> normal: once the limit is reached nothing more goes to the 401(k), so pay rises
// All money is integer cents; percentages are basis points (6% = 600).
import { parentOf } from './categories.js';

export const PAY_EVERY = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };
export const DEFAULT_401K_LIMIT = 2450000;          // 2026 employee limit, $24,500; change it in the plan when the IRS does
const TOLERANCE_BP = 200;                             // within 2% of the usual take-home counts as normal (taxes wobble)
const TOLERANCE_MIN = 2500;                           // ...or within $25, whichever is more

export function cleanPay(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  const every = PAY_EVERY[raw.every] ? raw.every : null;
  const gross = int(raw.gross, 1, 1e10), takeHome = int(raw.takeHome, 1, 1e10);
  const pct = int(raw.pct ?? 0, 0, 10000), match = int(raw.match ?? 0, 0, 10000), limit = int(raw.limit ?? DEFAULT_401K_LIMIT, 0, 1e10);
  if (!every || gross === null || takeHome === null || pct === null || match === null || limit === null || takeHome > gross) return null;
  return { every, gross, takeHome, pct, match, limit };
}

// What one ordinary paycheck is made of.
export function payParts(pay) {
  const contrib = Math.round(pay.gross * pay.pct / 10000);
  // the share of what's left after the 401(k) that reaches the bank (taxes and other deductions come out of the rest)
  const rate = pay.takeHome / Math.max(1, pay.gross - contrib);
  return { contrib, match: Math.round(pay.gross * pay.match / 10000), rate };
}

// Your usual take-home for a month: the yearly total spread evenly, so a month with a third paycheck isn't counted as a raise.
export const monthlyTakeHome = pay => Math.round(pay.takeHome * PAY_EVERY[pay.every] / 12);

const isPaycheck = t => {
  if (t.cents <= 0) return false;
  for (let at = t.category, n = 0; at && n < 6; at = parentOf(at), n++) if (at === 'income_paycheck') return true;
  return false;
};

// Reads every paycheck in `year` (YYYY) in date order. Returns { rows, totals }.
// rows: { id, date, cents, kind: 'normal' | 'bonus' | 'capped' | 'short', grossEst, contrib, match, extra }
//   extra = take-home above a normal paycheck (the bonus part); it is cash for you to use, and not part of the free-cash plan.
export function readPaychecks(txs, pay, year) {
  const rows = [];
  let ytd = 0, capDate = null;
  const { contrib: usual, rate } = payParts(pay);
  const lines = txs.filter(t => t.date.startsWith(year + '-') && isPaycheck(t)).sort((a, b) => a.date.localeCompare(b.date));
  for (const t of lines) {
    const room = Math.max(0, pay.limit - ytd);
    const contrib = Math.min(usual, room);
    // what a normal paycheck takes home given how much 401(k) is still taken from it (less is taken once the limit is near)
    const normalNet = Math.round((pay.gross - contrib) * rate);
    const tol = Math.max(TOLERANCE_MIN, Math.round(normalNet * TOLERANCE_BP / 10000));
    let kind, extra = 0, grossEst = pay.gross, c = contrib;
    if (Math.abs(t.cents - normalNet) <= tol) kind = room < usual ? 'capped' : 'normal';
    else if (t.cents < normalNet) { kind = 'short'; grossEst = Math.round(t.cents / rate / (1 - pay.pct / 10000 || 1)); c = Math.min(Math.round(grossEst * pay.pct / 10000), room); }
    else {
      kind = 'bonus';
      extra = t.cents - normalNet;
      // the 401(k) % usually applies to a bonus too, while there's room under the limit
      const roomAfter = room - contrib;
      const pctLeft = roomAfter > 0 ? pay.pct / 10000 : 0;
      const bonusGross = Math.round(extra / rate / (1 - pctLeft || 1));
      const bonusContrib = Math.min(Math.round(bonusGross * pay.pct / 10000), Math.max(0, roomAfter));
      grossEst = pay.gross + bonusGross; c = contrib + bonusContrib;
    }
    ytd += c;
    if (!capDate && ytd >= pay.limit && pay.limit > 0) capDate = t.date;
    rows.push({ id: t.id, date: t.date, cents: t.cents, kind, grossEst, contrib: c, match: Math.round(grossEst * pay.match / 10000), extra });
  }
  const sum = k => rows.reduce((s, r) => s + r[k], 0);
  return { rows, totals: { count: rows.length, takeHome: sum('cents'), extra: sum('extra'), contrib: sum('contrib'), match: sum('match'), gross: sum('grossEst'), limit: pay.limit, left: Math.max(0, pay.limit - ytd), capDate } };
}

// Phase 1 for one month: paychecks, the bonus part, and the 401(k) so far this year.
export function monthIncome(txs, pay, ym) {
  const year = readPaychecks(txs, pay, ym.slice(0, 4));
  const inMonth = year.rows.filter(r => r.date.startsWith(ym));
  const through = year.rows.filter(r => r.date.slice(0, 7) <= ym);
  const sum = (list, k) => list.reduce((s, r) => s + r[k], 0);
  return {
    planned: monthlyTakeHome(pay), received: sum(inMonth, 'cents'), extra: sum(inMonth, 'extra'), paychecks: inMonth,
    contribMonth: sum(inMonth, 'contrib'), matchMonth: sum(inMonth, 'match'),
    contribYtd: sum(through, 'contrib'), matchYtd: sum(through, 'match'), limit: pay.limit,
    capDate: year.totals.capDate && year.totals.capDate.slice(0, 7) <= ym ? year.totals.capDate : null,
  };
}

// Savings by account: what moved into each account you set a target for, this month (transfers in, less transfers out).
// Interest and anything else that isn't a transfer is left out, so it measures what you put away.
export function savingsByAccount(txs, targets, ym) {
  return Object.entries(targets ?? {}).map(([key, planned]) => {
    const account = key.startsWith('src:') ? key.slice(4) : key;
    const moved = txs.filter(t => t.account === account && t.date.startsWith(ym) && t.category === 'transfer').reduce((s, t) => s + t.cents, 0);
    return { key, planned, actual: moved };
  });
}

