// Your accounts, and which file belongs to which. Every statement file names its account by the last four digits,
// so once an account has its digits the app can recognise its files by itself.
import {
  SOURCE_ACCOUNTS, SOURCE_ROLES, ACCOUNT_TYPES, roleOfType, FAMILIES, BUILTIN_SOURCES, DEFAULT_OF_FAMILY, familyOf, last4Of, familyForFormat, accountKeysOfFamily, usedCodes,
} from './categories.js';

// What is saved: built-in accounts only remember their last four digits; accounts you add are saved whole.
const spareCode = (role, codes, raw) => {
  const all = new Set([...codes, ...raw.map(a => a?.code).filter(Boolean)]);
  for (let n = role === 'asset' ? 1040 : 2020; n < (role === 'asset' ? 1900 : 2100); n += 2) if (!all.has(String(n))) { all.add(String(n)); return String(n); }
  return role === 'asset' ? '1899' : '2099';
};

export function cleanAccounts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [], keys = new Set(), digits = new Set(), codes = new Set();
  for (const a of raw) {
    if (!a || typeof a.key !== 'string' || !/^[a-z0-9-]{3,32}$/.test(a.key) || keys.has(a.key)) continue;
    const last4 = /^\d{4}$/.test(a.last4 ?? '') && !digits.has(a.last4) ? a.last4 : '';
    const type = ACCOUNT_TYPES[a.type] ? a.type : undefined;
    if (BUILTIN_SOURCES.includes(a.key)) {
      keys.add(a.key); if (last4) digits.add(last4);
      const role = SOURCE_ROLES[a.key];
      out.push({ key: a.key, last4, ...(type && a.key !== 'venmo' && roleOfType(type) === role ? { type } : {}) });
      continue;
    }
    const name = typeof a.name === 'string' ? a.name.trim().slice(0, 60) : '';
    if (!name || !FAMILIES[a.family] || !['asset', 'liability'].includes(a.role)) continue;
    // an account is never dropped for its number: one saved with a number another account already has gets the next free one
    let code = /^\d{4}$/.test(a.code ?? '') ? a.code : '';
    if (!code || codes.has(code)) code = spareCode(a.role, codes, raw);
    const kind = type && roleOfType(type) === a.role ? type : a.role === 'liability' ? 'card' : a.family === 'venmo' ? 'venmo' : 'checking';
    keys.add(a.key); codes.add(code); if (last4) digits.add(last4);
    out.push({ key: a.key, name, family: a.family, role: a.role, type: kind, code, last4 });
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

// What kind of account a pasted line describes, from its words. Anything can be an account; the kind only decides where it sits.
export function guessType(line) {
  const t = String(line).toLowerCase();
  if (/venmo/.test(t)) return 'venmo';
  if (/credit|card|sapphire|freedom|southwest/.test(t)) return 'card';
  if (/invest|jpmorgan|brokerage|coinbase|crypto|401|ira\b|roth|fidelity|vanguard|schwab/.test(t)) return 'investment';
  if (/sav|high-yield|hysa|money market/.test(t)) return 'savings';
  return 'checking';
}
// The built-in account a first line of that kind takes over, so what is already imported stays with it.
const builtinFor = (type, line) => (type === 'venmo' ? 'venmo' : type === 'checking' ? 'chase-checking'
  : type === 'card' ? (/amex|american express/i.test(line) ? 'amex' : 'chase-card') : null);
// Which importer family a new account of this kind is filed under (what an earlier file of that kind would be moved from).
const familyFor = (type, line = '') => (type === 'venmo' ? 'venmo' : type === 'card' ? (/amex|american express/i.test(line) ? 'amex' : 'chase-card') : 'chase-bank');

// Numbers an account can't take: every number in use on the TB, and the number stored on every account in your list (an account you put
// under another one shows a new number, but its own stays reserved, so two accounts can never be saved with the same one).
const takenCodes = (accounts, coding) => new Set([...usedCodes(coding), ...accounts.map(a => a.code).filter(Boolean)]);

function freeCode(role, taken) {
  for (let n = role === 'asset' ? 1040 : 2020; n < (role === 'asset' ? 1900 : 2100); n += 10) if (!taken.has(String(n))) return String(n);
  throw new Error('No free account numbers left in that range.');
}

// Turns a pasted list ("Chase Savings (8527)" on each line) into accounts. The first checking account, card and so on takes over the
// one that is already there (so everything already imported stays with it); every other line becomes its own account.
export function addFromList(accounts, text, coding = {}) {
  let next = cleanAccounts(accounts);
  const renames = {}, report = { claimed: [], created: [], skipped: [] };
  const taken = takenCodes(next, coding), claimed = new Set();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim().replace(/\s+/g, ' ');
    if (!line) continue;
    const last4 = /\((\d{4})\)/.exec(line)?.[1] ?? /(?<!\d)(\d{4})\s*$/.exec(line)?.[1] ?? '';
    const type = guessType(line);
    if (last4 && next.some(a => a.last4 === last4)) { report.skipped.push(line); continue; }
    const def = builtinFor(type, line);
    if (def && !claimed.has(def) && !next.find(a => a.key === def)?.last4) {
      claimed.add(def);
      next = [...next.filter(a => a.key !== def), { key: def, last4 }];
      renames[`src:${def}`] = line;
      report.claimed.push(line);
      continue;
    }
    const role = roleOfType(type);
    const code = freeCode(role, taken); taken.add(code);
    const family = familyFor(type, line);
    const key = `${type}-${last4 || code}`;
    if (next.some(a => a.key === key)) { report.skipped.push(line); continue; }
    next = [...next, { key, name: line, family, role, type, code, last4 }];
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

// Adds one account (when a file turns up that belongs to none of yours). Returns { accounts, key }.
export function addAccountOfType(accounts, { name, type, last4 }, coding = {}) {
  if (!ACCOUNT_TYPES[type] || type === 'venmo' && accounts.some(a => a.key === 'venmo')) throw new Error('Choose what kind of account it is.');
  const clean = String(name ?? '').trim().slice(0, 60);
  if (!clean) throw new Error('Give the account a name.');
  const digits = String(last4 ?? '').trim();
  if (digits && !/^\d{4}$/.test(digits)) throw new Error('Use the last 4 digits, like 1044.');
  if (digits && accounts.some(a => a.last4 === digits)) throw new Error(`${digits} already belongs to another account.`);
  const role = roleOfType(type);
  const code = freeCode(role, takenCodes(accounts, coding));
  const key = `${type}-${digits || code}`;
  if (accounts.some(a => a.key === key) || SOURCE_ACCOUNTS[key]) throw new Error('That account already exists.');
  return { accounts: [...accounts, { key, name: clean, family: familyFor(type, clean), role, type, code, last4: digits }], key };
}

// Changes what kind an asset account is (Checking, Savings, Investment). A card stays a card.
export function setType(accounts, key, type) {
  if (!ACCOUNT_TYPES[type]) throw new Error('Choose what kind of account it is.');
  if (roleOfType(type) !== (SOURCE_ROLES[key] ?? 'asset')) throw new Error('An account can\u2019t change between an asset and a credit card.');
  const has = accounts.some(a => a.key === key);
  const list = has ? accounts : [...accounts, { key, last4: last4Of(key) }];
  return cleanAccounts(list.map(a => (a.key === key ? { ...a, type } : a)));
}

export { familyOf, familyForFormat, accountKeysOfFamily, DEFAULT_OF_FAMILY };
