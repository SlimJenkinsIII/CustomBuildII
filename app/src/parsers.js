// Each parser turns one bank's CSV into the standard transaction shape:
//   { date: 'YYYY-MM-DD', description, cents, account, source }
// Money convention: cents are integers. NEGATIVE = money out, POSITIVE = money in.
import { parseCsv, parseCsvObjects } from './csv.js';

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

export function parseStatement(text, account = '') {
  const vrows = venmoRows(text);
  if (vrows) { const v = venmo(vrows, account || 'venmo'); return { format: 'venmo', transactions: v.transactions, notes: v.notes }; }
  const rows = parseCsvObjects(text);
  const format = detectFormat(rows.length ? Object.keys(rows[0]) : []);
  if (!format) throw new Error('Unrecognized statement format. Expected a Chase, Amex or Venmo CSV.');
  const fn = { 'chase-checking': chaseChecking, 'chase-card': chaseCard, amex }[format];
  return { format, transactions: fn(rows, account || format) };
}
