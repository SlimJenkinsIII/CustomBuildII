// Chart of accounts + the categories the app files transactions under.
//
// GL code ranges:   1000 Assets   2000 Liabilities   3000 Equity   4000 Revenue   5000 Expenses   6000 Other income / loss   7000 Vacations
//
// Budget groups (how the spending hub treats each account):
//   income        -> take-home pay coming in (4000s)
//   fixed         -> monthly bills (5100s)
//   subscriptions -> recurring services (5200s)
//   onetime       -> one-time purchases and annual fees (6100), planned as a monthly set-aside
//   vacation      -> vacations (7000-7999), planned as one monthly set-aside, not part of weekly free cash.
//                    Each trip gets a hundred-block (7100 = trip 1, 7200 = trip 2 ... up to 7900), with the same
//                    accounts inside every block: x10 lodging, x20 flights, x30 food, x40 entertainment, ...
//                    Block 7000 holds vacation spending not yet assigned to a trip.
//   free          -> flexible spending; free cash = take-home - fixed - subscriptions - set-asides - savings (5400s)
//   savings       -> money moved into savings / investing. These are ASSET accounts (1000s), not spending.
//   other         -> interest, gains and losses (6000-6090). Kept out of the budget math.
// System: 'transfer' (card payments etc., ignored) and 'review' (not classified yet; a suspense account, 1900).
// Unclassified money-out counts against free cash until you classify it, so a miss errs on the strict side.

export const GROUPS = {
  income: 'Income',
  fixed: 'Fixed monthly expenses',
  subscriptions: 'Subscriptions',
  onetime: 'Annual & one-time',
  savings: 'Savings & investing',
  vacation: 'Vacations',
  free: 'Free cash',
  other: 'Other income & loss',
  system: 'System',
};

const c = (id, group, code, name) => [id, { id, group, code, name }];

// Vacation accounts: [kind, label, offset inside the trip's block]
export const VAC_KINDS = [
  ['lodging', 'Lodging', 10], ['flights', 'Flights', 20], ['food', 'Food & drink', 30], ['entertainment', 'Entertainment', 40],
  ['transport', 'Local transport', 50], ['shopping', 'Shopping & souvenirs', 60], ['other', 'Other', 90],
];
export const MAX_TRIPS = 9; // blocks 7100 ... 7900
const vacationEntries = [];
for (let slot = 0; slot <= MAX_TRIPS; slot++) {
  for (const [kind, label, offset] of VAC_KINDS) {
    vacationEntries.push([`vac${slot}_${kind}`, {
      id: `vac${slot}_${kind}`, group: 'vacation', code: String(7000 + slot * 100 + offset),
      name: slot === 0 ? `No trip yet \u00b7 ${label}` : `Trip ${slot} \u00b7 ${label}`, slot, kind,
    }]);
  }
}

export const CATEGORIES = Object.fromEntries([
  c('income_paycheck', 'income', '4000', 'Paycheck'),
  c('income_bonus', 'income', '4010', 'Bonus'),
  c('income_other', 'income', '4090', 'Reimbursements & other income'),

  c('fixed_rent', 'fixed', '5100', 'Rent'),
  c('fixed_utilities', 'fixed', '5110', 'Utilities (electric, gas, water, internet, phone)'),
  c('fixed_renters_ins', 'fixed', '5120', "Renter's insurance"),
  c('fixed_car', 'fixed', '5130', 'Car payment & insurance'),
  c('fixed_health', 'fixed', '5140', 'Health insurance & medical'),
  c('fixed_debt', 'fixed', '5150', 'Student loans & other debt'),

  c('sub_streaming', 'subscriptions', '5200', 'Subscriptions'),
  c('sub_software', 'subscriptions', '5210', 'Software & cloud'),
  c('sub_gym', 'subscriptions', '5220', 'Gym & memberships'),
  c('sub_other', 'subscriptions', '5290', 'Other subscriptions'),

  c('onetime_annual', 'onetime', '6100', 'One-time purchases & annual fees'),

  c('free_restaurants', 'free', '5400', 'Restaurants'),
  c('free_coffee', 'free', '5410', 'Coffee'),
  c('free_alcohol', 'free', '5420', 'Bars & alcohol'),
  c('free_groceries', 'free', '5430', 'Groceries'),
  c('free_entertainment', 'free', '5440', 'Entertainment'),
  c('free_shopping', 'free', '5450', 'Shopping & clothing'),
  c('free_personal', 'free', '5470', 'Personal care'),
  c('free_gifts', 'free', '5480', 'Gifts'),
  c('free_transport', 'free', '5490', 'Gas, rideshare & parking'),
  c('free_other', 'free', '5499', 'Everything else'),

  c('save_chase', 'savings', '1010', 'Chase Savings'),
  c('save_amex', 'savings', '1020', 'Amex High-Yield Savings'),
  c('save_invest', 'savings', '1100', 'Investment account'),
  c('save_crypto', 'savings', '1110', 'Crypto (Coinbase)'),

  c('other_interest', 'other', '6000', 'Interest income'),
  c('other_gains', 'other', '6010', 'Investment gains & losses'),
  c('other_crypto', 'other', '6020', 'Crypto gains & losses'),
  c('other_interest_exp', 'other', '6030', 'Interest expense & finance charges'),
  c('other_misc', 'other', '6090', 'Other income & loss'),

  ...vacationEntries,

  c('transfer', 'system', null, 'Transfer (not spending)'),
  c('review', 'system', '1900', 'Needs review'),
]);

// The accounts statements come from. Each statement file belongs to one of these.
export const SOURCE_ACCOUNTS = {
  'chase-checking': { code: '1000', name: 'Chase checking' },
  'chase-card': { code: '2000', name: 'Chase credit card' },
  amex: { code: '2010', name: 'Amex card' },
};

// Accounts that exist in the chart but no feature uses yet (they arrive with later phases).
const PLANNED = [
  { code: '1120', name: 'Venmo balance' },
  { code: '1200', name: '401(k) & retirement' },
  { code: '1300', name: 'Due from friends' },
  { code: '2100', name: 'Loans & other debt' },
];

// Accounts the app itself uses. They hold a number but cannot be renumbered.
export const SYSTEM_ACCOUNTS = [
  { key: 'clearing', code: '1910', name: 'Transfers in transit' },
  { key: 'equity', code: '3000', name: 'Opening balance equity' },
  { key: 'retained', code: '3100', name: 'Retained earnings' },
];

// Whether each statement account is something you have or something you owe.
export const SOURCE_ROLES = { 'chase-checking': 'asset', 'chase-card': 'liability', amex: 'liability' };

const CLASSES = { 1: 'Assets', 2: 'Liabilities', 3: 'Equity', 4: 'Revenue', 5: 'Expenses', 6: 'Other income / loss', 7: 'Vacations' };
export const classOf = code => CLASSES[code[0]];

export const codeLabel = id => {
  const cat = CATEGORIES[id];
  return cat.code ? `${cat.code} ${cat.name}` : cat.name;
};

export const sourceLabel = account => {
  const a = SOURCE_ACCOUNTS[account];
  return a ? `${a.code} ${a.name}` : account;
};

// Full chart of accounts, sorted by code, each marked active (used today) or planned.
export function chartOfAccounts(trips = []) {
  const open = new Set([0, ...trips.map(t => t.slot)]);
  const fromCategories = Object.values(CATEGORIES).filter(x => x.code && !(x.id in REMOVED) && (x.group !== 'vacation' || open.has(x.slot)))
    .map(x => ({ code: x.code, name: x.id === 'review' ? 'Suspense (needs review)' : x.name, status: 'Active' }));
  const fromSources = Object.values(SOURCE_ACCOUNTS).map(x => ({ ...x, status: 'Active' }));
  const planned = PLANNED.map(x => ({ ...x, status: 'Planned' }));
  return [...fromCategories, ...fromSources, ...planned]
    .map(a => ({ ...a, class: classOf(a.code) }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

// Names the vacation accounts after your trips: trip 2 called "Lisbon" makes 7210 "Lisbon · Lodging".
export function applyTripNames(trips = []) {
  for (let slot = 1; slot <= MAX_TRIPS; slot++) {
    const name = trips.find(t => t.slot === slot)?.name ?? `Trip ${slot}`;
    for (const [kind, label] of VAC_KINDS) CATEGORIES[`vac${slot}_${kind}`].name = `${name} \u00b7 ${label}`;
  }
}

// Categories you can pick for a transaction: everything except trip blocks that don't exist yet.
export function selectableCategories(trips = []) {
  const open = new Set([0, ...trips.map(t => t.slot)]);
  return Object.values(CATEGORIES)
    .filter(x => !(x.id in REMOVED) && (x.group !== 'vacation' || open.has(x.slot)))
    .map(x => ({ id: x.id, label: codeLabel(x.id), class: x.code ? classOf(x.code) : 'Not an account' }));
}

// ---------- TB coding: your own numbers for each account ----------
// The numbers above are the defaults. You can give any account a different 4-digit number; only the
// differences are saved. Source accounts (the banks and cards) are keyed "src:<account>".
const DEFAULT_CODES = Object.fromEntries(Object.values(CATEGORIES).map(x => [x.id, x.code]));
const DEFAULT_SOURCE_CODES = Object.fromEntries(Object.entries(SOURCE_ACCOUNTS).map(([k, v]) => [`src:${k}`, v.code]));
const DEFAULT_NAMES = Object.fromEntries([
  ...Object.values(CATEGORIES).map(x => [x.id, x.name]),
  ...Object.entries(SOURCE_ACCOUNTS).map(([k, v]) => [`src:${k}`, v.name]),
]);
export const defaultCode = key => (key.startsWith('src:') ? DEFAULT_SOURCE_CODES[key] : DEFAULT_CODES[key]);

// Every account that holds a number, with the number it would have under a given coding.
function accountsWith(coding) {
  return [
    ...Object.values(CATEGORIES).filter(x => DEFAULT_CODES[x.id] && !(x.id in REMOVED)).map(x => ({ key: x.id, name: x.name, code: coding[x.id] ?? DEFAULT_CODES[x.id] })),
    ...Object.entries(SOURCE_ACCOUNTS).map(([k, v]) => ({ key: `src:${k}`, name: v.name, code: coding[`src:${k}`] ?? DEFAULT_SOURCE_CODES[`src:${k}`] })),
    ...PLANNED.map(p => ({ key: `planned:${p.code}`, name: p.name, code: p.code })),
    ...SYSTEM_ACCOUNTS.map(a => ({ key: `system:${a.key}`, name: a.name, code: a.code })),
  ];
}

// ---------- your own names and sub accounts ----------
// Names: any account except trips (rename the trip), system accounts and Needs review can be renamed. Only the changes are saved.
// Sub accounts: you add one under any account and it takes the next free number below its parent
// (under 1100: 1110, 1120, ...; under 5110: 5111, 5112, ...). It files and reports like its parent.
const NO_RENAME = new Set(['transfer', 'review']);
export const canRename = key => key in DEFAULT_NAMES && !NO_RENAME.has(key) && CATEGORIES[key]?.group !== 'vacation';
const canParent = key => !!CATEGORIES[key] && !(key in REMOVED) && !!DEFAULT_CODES[key] && !['vacation', 'system'].includes(CATEGORIES[key].group);

export function cleanNames(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, name] of Object.entries(raw)) {
    const n = typeof name === 'string' ? name.trim().slice(0, 60) : '';
    if (canRename(key) && n && n !== DEFAULT_NAMES[key]) out[key] = n;
  }
  return out;
}

export function setName(names, key, name) {
  if (!canRename(key)) throw new Error('That account cannot be renamed here.');
  name = String(name).trim();
  if (!name) throw new Error('Type a name.');
  if (name.length > 60) throw new Error('Keep the name under 60 characters.');
  const next = { ...names };
  if (name === DEFAULT_NAMES[key]) delete next[key]; else next[key] = name;
  return next;
}

export function applyNames(names = {}) {
  for (const x of Object.values(CATEGORIES)) if (canRename(x.id)) x.name = names[x.id] ?? DEFAULT_NAMES[x.id];
  for (const [k, v] of Object.entries(SOURCE_ACCOUNTS)) v.name = names[`src:${k}`] ?? DEFAULT_NAMES[`src:${k}`];
}

// ---------- deleting an account ----------
// A deleted account is merged into another account of the same kind: anything filed under it, now or in future,
// lands in the one you chose. Nothing is lost, and Restore brings the account back. Savings accounts, banks and
// cards, trips and system accounts can't be deleted here.
let REMOVED = {};
const REMOVABLE_GROUPS = new Set(['income', 'fixed', 'subscriptions', 'free', 'other', 'onetime']);
export const isRemoved = id => id in REMOVED;
export function resolveCategory(id) {
  for (let i = 0; i < 20 && id in REMOVED; i++) id = REMOVED[id];
  return id;
}
export const removeTargets = id => {
  const group = CATEGORIES[id]?.group;
  return Object.values(CATEGORIES).filter(x => x.id !== id && x.group === group && DEFAULT_CODES[x.id] && !(x.id in REMOVED))
    .sort((a, b) => a.code.localeCompare(b.code)).map(x => ({ key: x.id, code: x.code, name: x.name }));
};
export const canRemove = id => !!CATEGORIES[id] && !CATEGORIES[id].custom && REMOVABLE_GROUPS.has(CATEGORIES[id].group) && !!DEFAULT_CODES[id] && !(id in REMOVED) && removeTargets(id).length > 0;

export function removeAccount(removed, id, target) {
  if (!canRemove(id)) throw new Error('That account cannot be deleted.');
  if (!removeTargets(id).some(t => t.key === target)) throw new Error('Choose an account of the same kind to move it into.');
  // anything already merged into the deleted account follows it to the new home
  const next = Object.fromEntries(Object.entries(removed).map(([k, v]) => [k, v === id ? target : v]));
  next[id] = target;
  return next;
}
export function restoreAccount(removed, id) {
  const next = { ...removed };
  delete next[id];
  return next;
}
export function cleanRemoved(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, target] of Object.entries(raw)) {
    const a = CATEGORIES[id], b = CATEGORIES[target];
    if (a && b && !a.custom && id !== target && a.group === b.group && REMOVABLE_GROUPS.has(a.group) && DEFAULT_CODES[id]) out[id] = target;
  }
  // drop anything that would lead round in a circle
  const looped = Object.keys(out).filter(id => { let at = id, n = 0; while (at in out && n++ < 30) at = out[at]; return at in out; });
  for (const id of looped) delete out[id];
  // an account can't be merged into one that no longer exists as a destination
  for (const id of Object.keys(out)) if (!CATEGORIES[resolveWith(out, id)]) delete out[id];
  return out;
}
const resolveWith = (map, id) => { for (let i = 0; i < 20 && id in map; i++) id = map[id]; return id; };
export function applyRemoved(removed = {}) { REMOVED = { ...removed }; }
export const removedList = () => Object.entries(REMOVED).map(([id, to]) => ({ key: id, code: DEFAULT_CODES[id], name: CATEGORIES[id]?.name, into: resolveCategory(id) }))
  .filter(r => CATEGORIES[r.key]).sort((a, b) => a.code.localeCompare(b.code));

// A sub account can carry words to look for in a statement line: "NETFLIX" files every Netflix charge under it.
export function cleanMatch(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return [...new Set(list.map(x => String(x).trim().toUpperCase().slice(0, 40)).filter(x => x.length >= 3))].slice(0, 5);
}
// The matching words become rules that run before the built-in ones. Income accounts match money in, everything else money out.
export function customRules(customs = []) {
  return customs.flatMap(x => (x.match ?? []).map(contains => ({ contains, category: x.id, sign: CATEGORIES[x.parent]?.group === 'income' ? 'in' : 'out' })));
}
export function setMatch(customs, id, text) {
  if (!customs.some(x => x.id === id)) throw new Error('That sub account does not exist.');
  return customs.map(x => (x.id === id ? { ...x, match: cleanMatch(text) } : x));
}

// ---------- your own accounts, and how accounts nest ----------
// Customs are [{ id, parent, group, code, name, match }]: accounts you add. `parent` is another account or nothing.
// Any account can be dragged under another one. That nests it, and its number follows:
//   top level          0100 steps   (5100, 5200, 5300 ...)
//   under a top level  steps of 10  (5100 -> 5110, 5120 ...)
//   under a sub        steps of 2   (5110 -> 5112, 5114 ...)
// Nesting stops there (three levels). Built-in accounts keep their own parent in PARENTS.
let PARENTS = {};
const GROUP_CLASS = { income: '4', fixed: '5', subscriptions: '5', free: '5', other: '6', onetime: '6', savings: '1' };
export const ADD_KINDS = [
  ['fixed', 'Fixed monthly expense'], ['subscriptions', 'Subscription'], ['free', 'Free-cash spending'], ['income', 'Income'],
  ['savings', 'Savings or investment account'], ['other', 'Other income & loss'], ['onetime', 'One-time or annual'],
];

export function cleanCustoms(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [], ids = new Set(), codes = new Set();
  for (const x of raw) {
    if (!x || !/^sub_[a-z0-9]{1,12}$/.test(x.id) || ids.has(x.id) || !/^\d{4}$/.test(String(x.code)) || codes.has(String(x.code))) continue;
    const builtin = CATEGORIES[x.parent] && !CATEGORIES[x.parent].custom && canParent(x.parent);
    const parent = ids.has(x.parent) || builtin ? x.parent : undefined;
    const group = GROUP_CLASS[x.group] ? x.group : (parent && (CATEGORIES[parent]?.group ?? out.find(o => o.id === parent)?.group));
    const name = typeof x.name === 'string' ? x.name.trim().slice(0, 60) : '';
    if (!GROUP_CLASS[group] || !name) continue;
    ids.add(x.id); codes.add(String(x.code));
    out.push({ id: x.id, ...(parent && { parent }), group, code: String(x.code), name, match: cleanMatch(x.match) });
  }
  return out;
}

export function applyCustoms(customs = []) {
  for (const x of Object.values(CATEGORIES)) if (x.custom) { delete CATEGORIES[x.id]; delete DEFAULT_CODES[x.id]; delete DEFAULT_NAMES[x.id]; }
  for (const x of customs) {
    CATEGORIES[x.id] = { id: x.id, group: x.group, code: x.code, name: x.name, custom: true, parent: x.parent };
    DEFAULT_CODES[x.id] = x.code; DEFAULT_NAMES[x.id] = x.name;
  }
}

// Which account each account sits under. Built-ins come from PARENTS, your own accounts carry theirs.
export const parentOf = id => {
  const p = CATEGORIES[id]?.custom ? CATEGORIES[id].parent : PARENTS[id];
  return p && CATEGORIES[p] && !(p in REMOVED) ? p : undefined;
};
export const depthOf = id => { let d = 0; for (let at = parentOf(id); at && d < 5; at = parentOf(at)) d++; return d; };
const childrenOf = (id, coding = {}) => Object.values(CATEGORIES).filter(x => DEFAULT_CODES[x.id] && !(x.id in REMOVED) && parentOf(x.id) === id)
  .map(x => x.id).sort((a, b) => (coding[a] ?? DEFAULT_CODES[a]).localeCompare(coding[b] ?? DEFAULT_CODES[b]));
const heightOf = (id, coding) => childrenOf(id, coding).reduce((h, c) => Math.max(h, 1 + heightOf(c, coding)), 0);
const subtreeOf = (id, coding) => [id, ...childrenOf(id, coding).flatMap(c => subtreeOf(c, coding))];
const isMovable = id => canParent(id);

export function cleanParents(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, p] of Object.entries(raw)) {
    if (CATEGORIES[id] && !CATEGORIES[id].custom && canParent(id) && CATEGORIES[p] && canParent(p) && id !== p) out[id] = p;
  }
  // no loops, and no deeper than three levels
  const parentIn = (map, id) => (CATEGORIES[id]?.custom ? CATEGORIES[id].parent : map[id]);
  const depth = id => { let d = 0, at = id; while (parentIn(out, at) && d < 6) { at = parentIn(out, at); d++; } return d; };
  for (const id of Object.keys(out)) if (depth(id) > 2) delete out[id];
  return out;
}
export function applyParents(parents = {}) { PARENTS = { ...parents }; }

// The next free number below a parent. Under 5100: 5110, 5120 ... Under 5110: 5112, 5114 ...
export function nextSubCode(parentCode, used) {
  const n = Number(parentCode);
  let steps;
  if (n % 100 === 0) steps = [10, 20, 30, 40, 50, 60, 70, 80, 90, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  else if (n % 10 === 0) steps = [2, 4, 6, 8, 1, 3, 5, 7, 9];
  else throw new Error(`${parentCode} is already at the deepest level, so nothing can go under it.`);
  const free = steps.map(k => String(n + k)).find(code => !used.has(code));
  if (!free) throw new Error(`${parentCode} has no free numbers left below it. Renumber something to make room.`);
  return free;
}

// The next free standard number in a section: the lowest free hundred (5100, 5200, 5300 ...).
export function nextHundred(cls, used) {
  for (let h = 1; h < 10; h++) {
    const code = `${cls}${h}00`;
    if (!used.has(code) && !(cls === '1' && h === 9)) return code;
  }
  throw new Error('That section has no free standard numbers left.');
}

const usedCodes = (coding, except = []) => new Set(accountsWith(coding).filter(a => !except.includes(a.key)).map(a => a.code));

// Adds a top-level account of a kind you choose. It takes the next free hundred in its section.
export function addAccount(customs, coding, kind, name, match = '') {
  if (!GROUP_CLASS[kind]) throw new Error('Choose what kind of account it is.');
  name = String(name).trim();
  if (!name) throw new Error('Type a name for the account.');
  if (name.length > 60) throw new Error('Keep the name under 60 characters.');
  const code = nextHundred(GROUP_CLASS[kind], usedCodes(coding));
  const id = `sub_${(Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(-10)}`;
  return { customs: [...customs, { id, group: kind, code, name, match: cleanMatch(match) }], id, code };
}

// Adds an account straight under another one. (The screen adds top-level accounts and you drag them; this is the same rule in code.)
export function addSub(customs, coding, parentKey, name, match = '') {
  if (!canParent(parentKey)) throw new Error('Choose an account to add the sub account under.');
  name = String(name).trim();
  if (!name) throw new Error('Type a name for the sub account.');
  if (name.length > 60) throw new Error('Keep the name under 60 characters.');
  const code = nextSubCode(coding[parentKey] ?? DEFAULT_CODES[parentKey], usedCodes(coding));
  const id = `sub_${(Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(-10)}`;
  return { customs: [...customs, { id, parent: parentKey, group: CATEGORIES[parentKey].group, code, name, match: cleanMatch(match) }], id, code };
}

// Removes an account you added. Anything that sat under it moves up to where it was.
export function removeSub(customs, id) {
  const gone = customs.find(x => x.id === id);
  return {
    customs: customs.filter(x => x.id !== id).map(x => (x.parent === id ? (gone?.parent ? { ...x, parent: gone.parent } : (({ parent, ...rest }) => rest)(x)) : x)),
    removed: [id],
  };
}

// Drops an account under another (target = an account key) or back to the top of its section (target = 'top').
// Returns new { coding, parents, customs } with every affected number reassigned, or throws a plain-English reason.
export function moveAccount({ coding = {}, parents = {}, customs = [] }, key, target) {
  if (!isMovable(key)) throw new Error('That account can’t be moved.');
  const codeOf = k => coding[k] ?? DEFAULT_CODES[k];
  const cls = codeOf(key)[0];
  const tree = subtreeOf(key, coding);
  let used = usedCodes(coding, tree);
  const nextCoding = { ...coding };
  const assign = (k, code) => { if (code === DEFAULT_CODES[k]) delete nextCoding[k]; else nextCoding[k] = code; used.add(code); };

  let newParent;
  let top;
  if (target === 'top') {
    top = codeOf(key).endsWith('00') && !parentOf(key) ? codeOf(key) : nextHundred(cls, used);
  } else {
    if (!isMovable(target) || tree.includes(target)) throw new Error('It can’t go under that account.');
    if (codeOf(target)[0] !== cls) throw new Error('Accounts stay in their own section: assets, income, expenses and so on.');
    if (depthOf(target) + 1 + heightOf(key, coding) > 2) throw new Error('Accounts nest three levels deep at most.');
    newParent = target;
    top = nextSubCode(codeOf(target), used);
  }
  // renumber the account, then everything under it in the order they were
  const place = (k, code) => { assign(k, code); for (const c of childrenOf(k, coding)) place(c, nextSubCode(code, used)); };
  place(key, top);

  const nextParents = { ...parents };
  let nextCustoms = customs;
  if (CATEGORIES[key].custom) {
    const newGroup = newParent ? CATEGORIES[newParent].group : CATEGORIES[key].group;
    const inTree = new Set(tree);
    nextCustoms = customs.map(x => {
      if (x.id === key) { const { parent, ...rest } = x; return { ...rest, ...(newParent && { parent: newParent }), group: newGroup }; }
      return inTree.has(x.id) ? { ...x, group: newGroup } : x;
    });
  } else if (newParent) nextParents[key] = newParent; else delete nextParents[key];
  return { coding: nextCoding, parents: nextParents, customs: nextCustoms };
}

// Keeps only entries that name a real account and hold a 4-digit number.
export function cleanCoding(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, code] of Object.entries(raw)) {
    if (defaultCode(key) && /^\d{4}$/.test(String(code)) && code !== defaultCode(key)) out[key] = String(code);
  }
  return out;
}

// Returns a new coding with one account renumbered, or throws a plain-English reason it can't be.
export function setCode(coding, key, code) {
  if (!defaultCode(key)) throw new Error('That account cannot be renumbered.');
  code = String(code).trim();
  if (!/^\d{4}$/.test(code)) throw new Error('Use a 4-digit number.');
  const next = { ...coding };
  if (code === defaultCode(key)) delete next[key]; else next[key] = code;
  const clash = accountsWith(next).find(a => a.code === code && a.key !== key);
  if (clash) throw new Error(`${code} is already used by ${clash.name}.`);
  return next;
}

// Puts the numbers into effect everywhere the app shows or sorts by them.
export function applyCoding(coding = {}) {
  for (const x of Object.values(CATEGORIES)) if (DEFAULT_CODES[x.id]) x.code = coding[x.id] ?? DEFAULT_CODES[x.id];
  for (const [k, v] of Object.entries(SOURCE_ACCOUNTS)) v.code = coding[`src:${k}`] ?? DEFAULT_SOURCE_CODES[`src:${k}`];
}

// The list shown on the TB coding screen: every account you can see, in number order.
export function codingList(trips = [], coding = {}, names = {}) {
  const open = new Set([0, ...trips.map(t => t.slot)]);
  const rows = [
    ...Object.values(CATEGORIES).filter(x => DEFAULT_CODES[x.id] && !(x.id in REMOVED) && (x.group !== 'vacation' || open.has(x.slot)))
      .map(x => ({ key: x.id, code: x.code, name: x.id === 'review' ? 'Suspense (needs review)' : x.name, status: x.custom ? 'Sub account' : 'Active', editable: true, renamable: canRename(x.id), droppable: canParent(x.id) && depthOf(x.id) < 2, movable: canParent(x.id), depth: depthOf(x.id), custom: !!x.custom, canRemove: !x.custom && canRemove(x.id) })),
    ...Object.entries(SOURCE_ACCOUNTS).map(([k, v]) => ({ key: `src:${k}`, code: v.code, name: v.name, status: 'Active', editable: true, renamable: true })),
    ...PLANNED.map(p => ({ key: `planned:${p.code}`, code: p.code, name: p.name, status: 'Planned', editable: false })),
    ...SYSTEM_ACCOUNTS.map(a => ({ key: `system:${a.key}`, code: a.code, name: a.name, status: 'Active', editable: false })),
  ];
  return rows.map(r => ({ ...r, class: classOf(r.code), changed: r.key in coding, renamed: r.key in names })).sort((a, b) => a.code.localeCompare(b.code));
}
