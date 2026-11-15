// Your accounts, and which file belongs to which. Every statement file names its account by the last four digits,
// so once an account has its digits the app can recognise its files by itself.
import {
  SOURCE_ACCOUNTS, FAMILIES, BUILTIN_SOURCES, DEFAULT_OF_FAMILY, familyOf, last4Of, familyForFormat, accountKeysOfFamily, roleOfFamily, usedCodes,
} from './categories.js';

// What is saved: built-in accounts only remember their last four digits; accounts you add are saved whole.
export function cleanAccounts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [], keys = new Set(), digits = new Set(), codes = new Set();
  for (const a of raw) {
    if (!a || typeof a.key !== 'string' || !/^[a-z0-9-]{3,32}$/.test(a.key) || keys.has(a.key)) continue;
    const last4 = /^\d{4}$/.test(a.last4 ?? '') && !digits.has(a.last4) ? a.last4 : '';
    if (BUILTIN_SOURCES.includes(a.key)) { keys.add(a.key); if (last4) digits.add(last4); out.push({ key: a.key, last4 }); continue; }
    const name = typeof a.name === 'string' ? a.name.trim().slice(0, 60) : '';
    if (!name || !FAMILIES[a.family] || !['asset', 'liability'].includes(a.role) || !/^\d{4}$/.test(a.code ?? '') || codes.has(a.code)) continue;
    keys.add(a.key); codes.add(a.code); if (last4) digits.add(last4);
    out.push({ key: a.key, name, family: a.family, role: a.role, code: a.code, last4 });
  }
  return out;
}

// The four-digit numbers in a file name that stand on their own ("Chase1044_Activity_20260105.CSV" -> 1044, not 2026 or 0105).
export function digitsInName(fileName) {
  const base = String(fileName ?? '').replace(/\.[A-Za-z0-9]+$/, '');
  return [...base.matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map(m => m[1]);
}

// Which of your accounts a file belongs to, going by its name. null when the name has no digits you have set up.
export function accountForFile(fileName) {
  const digits = digitsInName(fileName);
  const keys = Object.keys(SOURCE_ACCOUNTS);
  for (const d of digits) { const key = keys.find(k => last4Of(k) === d); if (key) return key; }
  return null;
}

// What kind of account each pasted line describes, from its words. family is null when no file importer exists for it yet.
export function guessFamily(line) {
  const t = String(line).toLowerCase();
  if (/venmo/.test(t)) return 'venmo';
  const card = /credit|card/.test(t);
  if (/amex|american express/.test(t)) return card && !/savings/.test(t) ? 'amex' : null;           // Amex savings has no importer yet
  if (/southwest|sapphire|freedom|chase/.test(t) && card) return 'chase-card';
  if (/chase|checking|savings/.test(t) && !card) return /jpmorgan|coinbase|brokerage|invest/.test(t) ? null : 'chase-bank';
  return null;
}

function freeCode(role, taken) {
  for (let n = role === 'asset' ? 1040 : 2020; n < (role === 'asset' ? 1900 : 2100); n += 10) if (!taken.has(String(n))) return String(n);
  throw new Error('No free account numbers left in that range.');
}

// Turns a pasted list ("Chase Savings (8527)" on each line) into accounts. The first account of each kind takes over the one that
// is already there (so everything already imported stays with it); the rest are added. Returns what happened, line by line.
export function addFromList(accounts, text, coding = {}) {
  let next = cleanAccounts(accounts);
  const renames = {}, report = { claimed: [], created: [], unsupported: [], skipped: [] };
  const taken = new Set(usedCodes(coding));
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const last4 = /(\d{4})\s*\)?\s*$/.exec(line)?.[1] ?? (/\((\d{4})\)/.exec(line)?.[1] ?? '');
    const name = line.replace(/\s+/g, ' ');
    const family = guessFamily(line);
    if (!family) { report.unsupported.push(line); continue; }
    if (last4 && next.some(a => a.last4 === last4)) { report.skipped.push(line); continue; }
    const def = DEFAULT_OF_FAMILY[family];
    const defTaken = next.find(a => a.key === def)?.last4;
    if (!defTaken) {                                                    // the built-in account of that kind takes this one
      next = [...next.filter(a => a.key !== def), { key: def, last4 }];
      renames[`src:${def}`] = name;
      report.claimed.push(line);
      continue;
    }
    const role = roleOfFamily(family);
    const code = freeCode(role, taken); taken.add(code);
    const key = `${family}-${last4 || code}`;
    if (next.some(a => a.key === key)) { report.skipped.push(line); continue; }
    next = [...next, { key, name, family, role, code, last4 }];
    report.created.push(line);
  }
  return { accounts: next, renames, report };
}

// Sets (or clears) one account's last four digits. Throws a plain reason if another account already has them.
export function setLast4(accounts, key, last4) {
  const digits = String(last4 ?? '').trim();
  if (digits && !/^\d{4}$/.test(digits)) throw new Error('Use the last 4 digits, like 1044.');
  if (digits && accounts.some(a => a.key !== key && a.last4 === digits)) throw new Error(`${digits} already belongs to another account.`);
  const has = accounts.some(a => a.key === key);
  if (!has) return cleanAccounts([...accounts, { key, last4: digits }]);
  return accounts.map(a => (a.key === key ? { ...a, last4: digits } : a));
}

// Adds one account of a kind (when a file turns up that belongs to none of yours). Returns { accounts, key }.
export function addAccountOfFamily(accounts, { name, family, last4 }, coding = {}) {
  if (!FAMILIES[family]) throw new Error('Choose what kind of account it is.');
  const clean = String(name ?? '').trim().slice(0, 60);
  if (!clean) throw new Error('Give the account a name.');
  const digits = String(last4 ?? '').trim();
  if (digits && !/^\d{4}$/.test(digits)) throw new Error('Use the last 4 digits, like 1044.');
  if (digits && accounts.some(a => a.last4 === digits)) throw new Error(`${digits} already belongs to another account.`);
  const role = roleOfFamily(family);
  const code = freeCode(role, usedCodes(coding));
  const key = `${family}-${digits || code}`;
  if (accounts.some(a => a.key === key) || SOURCE_ACCOUNTS[key]) throw new Error('That account already exists.');
  return { accounts: [...accounts, { key, name: clean, family, role, code, last4: digits }], key };
}

export { familyOf, familyForFormat, accountKeysOfFamily, DEFAULT_OF_FAMILY };
