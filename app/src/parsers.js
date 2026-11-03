// Each parser turns one bank's CSV into the standard transaction shape:
//   { date: 'YYYY-MM-DD', description, cents, account, source }
// Money convention: cents are integers. NEGATIVE = money out, POSITIVE = money in.
import { parseCsvObjects } from './csv.js';

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

export function detectFormat(headers) {
  const h = new Set(headers);
  if (h.has('Posting Date') && h.has('Details')) return 'chase-checking';
  if (h.has('Transaction Date') && h.has('Post Date') && h.has('Type')) return 'chase-card';
  if (h.has('Date') && h.has('Description') && h.has('Amount')) return 'amex';
  return null;
}

export function parseStatement(text, account = '') {
  const rows = parseCsvObjects(text);
  const format = detectFormat(rows.length ? Object.keys(rows[0]) : []);
  if (!format) throw new Error('Unrecognized statement format. Expected a Chase or Amex CSV.');
  const fn = { 'chase-checking': chaseChecking, 'chase-card': chaseCard, amex }[format];
  return { format, transactions: fn(rows, account || format) };
}
