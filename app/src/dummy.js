// Made-up numbers for showing the app to friends. Nothing here comes from your data: it is generated
// from a fixed seed, so it looks the same every time, and its dates are relative to today so the
// screens always look current. Six months of statements, a plan and one trip.
import { withIds } from './ledger.js';
import { addTrip } from './trips.js';

const MONTHS_BACK = 5;
const pad = n => String(n).padStart(2, '0');
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12

function seeded(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const dummyPlan = {
  income: 500000,
  vacation: 25000,
  planned: {
    fixed_rent: 185000, fixed_utilities: 14000, sub_streaming: 2800, sub_software: 1000, onetime_annual: 8000,
    save_chase: 60000, save_amex: 40000, save_invest: 50000,
  },
};

export function dummySnapshot(today = new Date()) {
  const rand = seeded(20260101);
  const between = (lo, hi) => Math.round(lo + rand() * (hi - lo));       // cents
  const ty = today.getUTCFullYear(), tm = today.getUTCMonth() + 1, td = today.getUTCDate();
  const todayIso = `${ty}-${pad(tm)}-${pad(td)}`;

  const rows = [];
  const add = (account, y, m, d, description, cents) => {
    const date = `${y}-${pad(m)}-${pad(Math.min(d, daysIn(y, m)))}`;
    if (date <= todayIso) rows.push({ account, source: account, date, description, cents });
  };

  const months = [];
  for (let i = MONTHS_BACK; i >= 0; i--) {
    const idx = ty * 12 + (tm - 1) - i;
    months.push({ y: Math.floor(idx / 12), m: (idx % 12) + 1, i: MONTHS_BACK - i });
  }
  const first = months[0];

  // paychecks: every other Friday through the whole stretch
  const start = new Date(Date.UTC(first.y, first.m - 1, 1));
  const toFriday = (5 - start.getUTCDay() + 7) % 7;
  for (let d = new Date(start.getTime() + toFriday * 86400000); ; d = new Date(d.getTime() + 14 * 86400000)) {
    const iso = d.toISOString().slice(0, 10);
    if (iso > todayIso) break;
    rows.push({ account: 'chase-checking', source: 'chase-checking', date: iso, description: 'ACME CORP PAYROLL', cents: 230000 });
  }

  for (const { y, m, i } of months) {
    add('chase-checking', y, m, 1, 'ACH DEBIT HARBOR PROPERTY MANAGEMENT', -185000);
    add('chase-checking', y, m, 10, 'ONLINE TRANSFER TO SAV ...1234', -60000);
    add('chase-checking', y, m, 12, 'SPECTRUM', -6500);
    add('chase-checking', y, m, 18, 'AT&T', -between(5500, 8000));
    add('chase-checking', y, m, 5, 'WHOLEFDS MKT 10234', -between(3500, 9000));
    add('chase-checking', y, m, 20, 'HEB #404', -between(4000, 8500));
    add('chase-checking', y, m, 28, 'INTEREST PAYMENT', between(300, 450));

    add('amex', y, m, 3, 'NETFLIX.COM', -1549);
    add('amex', y, m, 7, 'MICROSOFT*MICROSOFT 365', -999);
    add('amex', y, m, 12, 'SPOTIFY USA', -1199);
    for (const d of [8, 17, 26]) add('amex', y, m, d, "TRADER JOE'S #123", -between(4000, 9500));
    add('amex', y, m, 9, 'CHIPOTLE 1234', -between(1100, 1900));
    add('amex', y, m, 14, 'DOORDASH*THAI BASIL', -between(2800, 4400));
    add('amex', y, m, 21, 'UBER EATS', -between(2400, 9500));
    add('amex', y, m, 27, 'DOORDASH*PIZZA', -between(2400, 4000));
    add('amex', y, m, 6, 'SHELL OIL 57444', -between(3200, 4800));
    add('amex', y, m, 19, 'SHELL OIL 57444', -between(3000, 4600));
    if (i % 2 === 0) add('amex', y, m, 16, 'TOTAL WINE & MORE', -between(4500, 9000));

    for (const d of [2, 9, 23]) add('chase-card', y, m, d, 'SQ *BLUE BOTTLE 0423', -between(450, 525));
    add('chase-card', y, m, 16, 'STARBUCKS STORE 1142', -between(560, 700));
    add('chase-card', y, m, 11, 'AMZN MKTP US*2K4PL8', -between(1800, 11000));
    add('chase-card', y, m, 26, 'ULTA BEAUTY #512', -between(2200, 5800));
    add('chase-card', y, m, 22, 'UBER *TRIP', -between(1200, 2900));

    // one-off costs, and one trip's flight and lodging a month before it
    if (i === 1) add('amex', y, m, 20, 'ANNUAL MEMBERSHIP FEE', -69500);
    if (i === 2) add('amex', y, m, 8, 'DMV VEHICLE REGISTRATION', -10500);
    if (i === 3) { add('chase-card', y, m, 2, 'DELTA AIR LINES 0067', -between(39000, 45000)); add('amex', y, m, 10, 'AIRBNB HMBXQ4', -between(60000, 70000)); }

    // last month's card bills, paid from checking (both sides, so the pair matches)
    const prev = months[i - 1];
    if (prev) {
      for (const [account, label, day, paid] of [['amex', 'PAYMENT TO AMEX EPAYMENT', 5, 'ONLINE PAYMENT - THANK YOU'], ['chase-card', 'PAYMENT TO CHASE CARD ENDING IN 1234', 8, 'PAYMENT THANK YOU']]) {
        const prefix = `${prev.y}-${pad(prev.m)}`;
        const total = rows.filter(r => r.account === account && r.date.startsWith(prefix) && r.cents < 0).reduce((s, r) => s - r.cents, 0);
        if (total && `${y}-${pad(m)}-${pad(day)}` <= todayIso) {
          add('chase-checking', y, m, day, label, -total);
          add(account, y, m, day, paid, total);
        }
      }
    }
  }

  // The trip: a week the month after the flight and lodging were booked.
  const tripMonth = months[Math.min(4, months.length - 1)];
  const trips = addTrip([], { name: 'Lake Tahoe', start: `${tripMonth.y}-${pad(tripMonth.m)}-05`, end: `${tripMonth.y}-${pad(tripMonth.m)}-12` });

  // made-up balances at the end of 2024, so the trial balance has somewhere to start
  const opening = { date: '2024-12-31', balances: { 'src:chase-checking': 420000, save_chase: 1200000, save_amex: 1800000, save_invest: 2500000, save_crypto: 300000 } };
  return { version: 1, raw: withIds(rows), overrides: {}, trips, plan: dummyPlan, coding: {}, opening };
}
