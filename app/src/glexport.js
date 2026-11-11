// A general-ledger export you can hand to someone (or to an assistant) to analyse: one row per debit or credit line of
// every entry in a date range. Nothing here touches the network; it only builds text for you to save or share.
//
// You choose how much of the statement wording leaves the app:
//   merchant  the merchant's name with store numbers and places removed ("WHOLEFDS MKT"). The default.
//   full      the description exactly as the bank wrote it
//   none      no names at all: just dates, accounts and amounts
// Account numbers, balances, your passphrase and your opening balances are never included.
import { buildJournal, accountInfo } from './journal.js';
import { CATEGORIES, SOURCE_ACCOUNTS, chartOfAccounts, classOf, parentOf } from './categories.js';
import { merchantKey } from './bulk.js';

export const NAME_MODES = [
  ['merchant', 'Merchant names only (store numbers and places removed)'],
  ['full', 'Full descriptions, as on the statement'],
  ['none', 'No names: dates, accounts and amounts only'],
];

export const GL_HEADER = ['Date', 'Entry', 'Account', 'Account name', 'Debit', 'Credit', 'Description', 'Bank or card', 'How it was filed'];

const dollars = cents => (cents / 100).toFixed(2);

// "How it was filed", in plain words, from what the app recorded about the transaction.
function howFiled(t) {
  if (!t) return '';
  if (t.byHand) return 'entered by hand';
  if (t.chosen) return 'your choice';
  if (/^learned/.test(t.categoryReason ?? '')) return 'learned from your choices';
  if (t.category === 'transfer') return 'transfer between accounts';
  if (t.category === 'review') return 'needs review';
  if (/^gas station/.test(t.categoryReason ?? '')) return 'gas-station split';
  if (/^rule/.test(t.categoryReason ?? '')) return 'automatic rule';
  return 'automatic';
}

function describe(t, names) {
  if (!t || names === 'none') return '';
  if (names === 'full') return t.description;
  return merchantKey(t.description) || '(unknown)';
}

// Returns { header, rows, entries, debit, credit } for entries dated from..to (inclusive, ISO dates; either may be '').
export function glExport(txs, { from = '', to = '', names = 'merchant' } = {}) {
  const byId = new Map(txs.map(t => [t.id, t]));
  const entries = buildJournal(txs).filter(e => (!from || e.date >= from) && (!to || e.date <= to))
    .map((e, i) => ({ e, i })).sort((a, b) => a.e.date.localeCompare(b.e.date) || a.i - b.i).map(x => x.e);
  const rows = [];
  let debit = 0, credit = 0;
  entries.forEach((e, n) => {
    const t = byId.get(e.txIds[0]);
    const desc = describe(t, names);
    const bank = e.txIds.length === 1 && t ? (SOURCE_ACCOUNTS[t.account]?.name ?? t.account) : e.txIds.length > 1 ? e.txIds.map(id => SOURCE_ACCOUNTS[byId.get(id)?.account]?.name).filter(Boolean).join(' / ') : '';
    for (const l of e.lines) {
      const a = accountInfo(l.key);
      rows.push([e.date, n + 1, a.code, a.name, l.debit ? dollars(l.debit) : '', l.credit ? dollars(l.credit) : '', desc, bank, howFiled(t)]);
      debit += l.debit; credit += l.credit;
    }
  });
  return { header: GL_HEADER, rows, entries: entries.length, debit, credit };
}

// The accounts, for context: number, name, section, and what each sits under.
export function chartExport(trips = []) {
  const keyOf = new Map([...Object.values(CATEGORIES).filter(c => c.code).map(c => [c.code, c.id]), ...Object.entries(SOURCE_ACCOUNTS).map(([k, v]) => [v.code, `src:${k}`])]);
  const rows = chartOfAccounts(trips).map(a => {
    const parent = keyOf.has(a.code) ? parentOf(keyOf.get(a.code)) : undefined;
    return [a.code, a.name, a.class ?? classOf(a.code) ?? '', parent ? accountInfo(parent).name : ''];
  });
  return { header: ['Account', 'Account name', 'Section', 'Sits under'], rows };
}

// Turns rows into CSV text. Cells that a spreadsheet could read as a formula get a leading apostrophe.
export function toCsv(header, rows) {
  const cell = v => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function exportFileName(from, to, kind = 'gl') {
  const span = from || to ? `${from || 'start'}-to-${to || 'latest'}` : 'all';
  return `${kind}-export-${span}.csv`;
}
