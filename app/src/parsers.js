// Each parser turns one bank's CSV into the standard transaction shape:
//   { date: 'YYYY-MM-DD', description, cents, account, source }
// Money convention: cents are integers. NEGATIVE = money out, POSITIVE = money in.
import { parseCsv, parseCsvObjects } from './csv.js';
import { endOfDayBalances, dayBefore } from './balances.js';

export function toCents(str) {
  const s = String(str).replace(/[$,\s]/g, '');
  const neg = s.startsWith('-') || (s.startsWith('(') && s.endsWith(')'));
  const n = s.replace(/[-()]/g, '');
  if (!/^\d*\.?\d+$|^\d+\.?$/.test(n)) throw new Error(`Cannot read amount: "${str}"`);
  const [whole, frac = ''] = n.split('.');
  const cents = parseInt(whole || '0', 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
  return neg ? -cents : cents;
}

export function toIsoDate(str) {
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new Error(`Cannot read date: "${str}"`);
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

// Chase checking/savings: Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
// (amounts are already signed: spending is negative)
function chaseChecking(rows, account) {
  return rows.map(r => ({
    date: toIsoDate(r['Posting Date']), description: r['Description'],
    cents: toCents(r['Amount']), account, source: 'chase-checking',
  }));
}

// Chase credit card: Transaction Date,Post Date,Description,Category,Type,Amount,Memo
// (amounts are already signed: purchases negative, payments positive)
function chaseCard(rows, account) {
  return rows.map(r => ({
    date: toIsoDate(r['Transaction Date']), description: r['Description'],
    cents: toCents(r['Amount']), account, source: 'chase-card',
  }));
}

// Amex: Date,Description,Amount   (charges are POSITIVE, payments/credits negative -> flip sign)
function amex(rows, account) {
  return rows.map(r => ({
    date: toIsoDate(r['Date']), description: r['Description'],
    cents: -toCents(r['Amount']), account, source: 'amex',
  }));
}

// Venmo (Statements -> Download CSV). The file starts with a couple of title lines, then the column names:
//   ,ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (tax),Amount (fee),...,Funding Source,Destination,...
// "Amount (total)" reads like "+ $20.00" or "- $15.00". Only what moves the Venmo BALANCE is imported:
//   - money that came in,
//   - payments made from the Venmo balance, and
//   - transfers to your bank.
// A payment you funded from a bank or card is already on that bank or card statement, so importing it here would count it twice.
const venmoAmount = text => {
  const s = String(text).replace(/[$,\s]/g, '');
  const negative = s.startsWith('-') || (s.startsWith('(') && s.endsWith(')'));
  return (negative ? -1 : 1) * Math.abs(toCents(s.replace(/^[+-]/, '')));
};
const TRANSFER_TYPE = /transfer|cash ?out|withdraw/i;

function venmoRows(text) {
  const rows = parseCsv(text);
  const at = rows.findIndex(r => r.some(c => c.trim() === 'Datetime') && r.some(c => c.trim() === 'Amount (total)'));
  if (at < 0) return null;
  const keys = rows[at].map(c => c.trim());
  return rows.slice(at + 1).map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

export function venmo(rows, account) {
  const out = [], details = [];
  let external = 0, ignored = 0;
  for (const r of rows) {
    if (!r['Datetime'] || !r['Amount (total)']) continue;                       // the balance rows at the top and bottom
    if (!/^(complete|issued)$/i.test(r['Status'])) { ignored++; continue; }     // pending, cancelled and failed rows moved no money
    const cents = venmoAmount(r['Amount (total)']);
    if (cents === 0) continue;
    const type = r['Type'];
    const transfer = TRANSFER_TYPE.test(type);
    const fromBalance = !r['Funding Source'] || /venmo balance/i.test(r['Funding Source']);
    if (cents < 0 && !transfer && !fromBalance) {                                // paid from a bank or card: it is on that statement
      external++;
      details.push({ date: r['Datetime'].slice(0, 10), cents, party: r['To'] || '', note: r['Note'] });   // kept only to say who and why
      continue;
    }
    const party = (cents > 0 ? r['From'] : r['To']) || '';
    const note = r['Note'];
    const description = transfer
      ? `VENMO TRANSFER TO BANK${r['Destination'] ? ` (${r['Destination']})` : ''}`
      : `${cents > 0 ? 'FROM' : 'TO'} ${party.toUpperCase()}${note ? `: ${note}` : ''}`.trim();
    out.push({ date: r['Datetime'].slice(0, 10), description, cents, account, source: 'venmo' });
  }
  return { transactions: out, notes: { external, ignored, details } };
}

export function detectFormat(headers) {
  const h = new Set(headers);
  if (h.has('Posting Date') && h.has('Details')) return 'chase-checking';
  if (h.has('Transaction Date') && h.has('Post Date') && h.has('Type')) return 'chase-card';
  if (h.has('Date') && h.has('Description') && h.has('Amount')) return 'amex';
  return null;
}

// Venmo statements show the balance at the start of the period (above the lines) and at the end (below them).
function venmoAnchors(rows, account, dates) {
  const money = r => { const v = (r || '').replace(/[$,\s]/g, ''); return v ? toCents(v) : null; };
  const begin = rows.map(r => money(r['Beginning Balance'])).find(v => v !== null);
  const end = [...rows].reverse().map(r => money(r['Ending Balance'])).find(v => v !== null);
  const out = [];
  if (dates.length) {
    const sorted = [...dates].sort();
    if (begin !== undefined) out.push({ account, date: dayBefore(sorted[0]), cents: begin, kind: 'file' });
    if (end !== undefined) out.push({ account, date: sorted[sorted.length - 1], cents: end, kind: 'file' });
  }
  return out;
}

export function parseStatement(text, account = '') {
  const vrows = venmoRows(text);
  if (vrows) {
    const acct = account || 'venmo';
    const v = venmo(vrows, acct);
    const dates = vrows.filter(r => r['Datetime'] && /^(complete|issued)$/i.test(r['Status'])).map(r => r['Datetime'].slice(0, 10));
    return { format: 'venmo', transactions: v.transactions, notes: v.notes, anchors: venmoAnchors(vrows, acct, dates) };
  }
  let rows = parseCsvObjects(text);
  let format = detectFormat(rows.length ? Object.keys(rows[0]) : []);
  if (!format) { const f = findHeader(text); const alt = detectFormat(f.headers); if (alt) { format = alt; rows = f.rows; } }
  if (!format) { const e = new Error('Unrecognized statement format. Expected a Chase, Amex or Venmo CSV.'); e.unknown = true; throw e; }
  const fn = { 'chase-checking': chaseChecking, 'chase-card': chaseCard, amex }[format];
  const acct = account || format;
  const out = { format, transactions: fn(rows, acct), anchors: [] };
  if (format === 'chase-checking') {
    // the running balance on each line gives the closing balance of each day
    const lines = rows.map(r => ({ date: toIsoDate(r['Posting Date']), cents: toCents(r['Amount']), bal: r['Balance'] === undefined || r['Balance'] === '' ? NaN : toCents(r['Balance']) }));
    out.anchors = endOfDayBalances(lines).map(a => ({ account: acct, ...a, kind: 'file' }));
  }
  return out;
}

// ---------- any other bank's CSV: you say which column is which, once ----------
// Many files start with a few lines of account details before the column names. The column-name row is the first one, within the
// first 15, that has a date-like heading and at least two other headings.
export function findHeader(text) {
  const rows = parseCsv(text);
  const at = rows.slice(0, 15).findIndex(r => r.filter(c => c.trim()).length >= 3 && r.some(c => /date/i.test(c)));
  const i = at < 0 ? 0 : at;
  const headers = (rows[i] ?? []).map(c => c.trim());
  const body = rows.slice(i + 1).filter(r => r.filter(c => c.trim()).length >= 2);
  return { headers, rows: body.map(r => Object.fromEntries(headers.map((k, j) => [k, (r[j] ?? '').trim()]))) };
}
// A stable fingerprint of a file's columns, so the same kind of file is read the same way next time.
export const headerKey = headers => headers.map(h => h.toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean).join('|');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Reads 01/05/2026, 1/5/26, 2026-01-05, 2026-01-05T10:00:00, "Jan 5, 2026" and "05 Jan 2026". null if it can't.
export function flexDate(str) {
  const s = String(str ?? '').trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/))) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  if ((m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/)) && MONTHS[m[1].toLowerCase()]) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/)) && MONTHS[m[2].toLowerCase()]) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}
const iso = (y, mo, d) => (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
const money = v => { const t = String(v ?? '').trim(); if (!t || t === '-' || t === '--') return 0; try { return toCents(t); } catch { return null; } };

// map: { date, description, amount } or { date, description, debit, credit }, plus optional { balance, outIsPositive, skip }.
//   outIsPositive: the file shows money out as a positive number (cards often do), so the sign is flipped.
//   skip: words that mark rows to leave out, like buys and sells inside an investment account.
// Returns { transactions, anchors, skipped, unreadable }.
export function parseMapped(text, map, account) {
  const { rows } = findHeader(text);
  const skip = (map.skip ?? []).map(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'));
  const out = [], lines = [];
  let skipped = 0, unreadable = 0;
  for (const r of rows) {
    const date = flexDate(r[map.date]);
    let cents = map.amount ? money(r[map.amount]) : (money(r[map.credit]) ?? 0) - Math.abs(money(r[map.debit]) ?? 0);
    if (!date || cents === null) { unreadable++; continue; }
    if (map.outIsPositive && map.amount) cents = -cents;
    const description = (map.description ? r[map.description] : '') || Object.values(r).filter(Boolean).join(' ').slice(0, 80);
    if (skip.length && skip.some(re => Object.values(r).some(v => re.test(v)))) { skipped++; continue; }
    if (cents === 0) continue;
    out.push({ date, description, cents, account, source: 'mapped' });
    // an investment account's running balance is cash only (it drops when you buy shares), so it can't check the account once buys are left out
    if (map.balance && !skip.length) { const b = money(r[map.balance]); if (b !== null && r[map.balance] !== '') lines.push({ date, cents, bal: b }); }
  }
  return { transactions: out, anchors: endOfDayBalances(lines).map(a => ({ account, ...a, kind: 'file' })), skipped, unreadable };
}

export function cleanFormats(raw) {
  if (!Array.isArray(raw)) return [];
  const str = v => (typeof v === 'string' && v.length <= 80 ? v : undefined);
  return raw.filter(f => f && typeof f.key === 'string' && f.key.length <= 2000 && str(f.date) && (str(f.amount) || (str(f.debit) && str(f.credit))))
    .map(f => ({ key: f.key, date: f.date, description: str(f.description), amount: str(f.amount), debit: str(f.debit), credit: str(f.credit), balance: str(f.balance),
      outIsPositive: !!f.outIsPositive, skip: Array.isArray(f.skip) ? f.skip.filter(w => typeof w === 'string' && w.length <= 30).slice(0, 20) : [] }))
    .slice(0, 50);
}
