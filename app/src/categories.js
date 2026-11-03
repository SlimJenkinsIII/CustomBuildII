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

  c('sub_streaming', 'subscriptions', '5200', 'Streaming & music'),
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
  const fromCategories = Object.values(CATEGORIES).filter(x => x.code && (x.group !== 'vacation' || open.has(x.slot)))
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
    .filter(x => x.group !== 'vacation' || open.has(x.slot))
    .map(x => ({ id: x.id, label: codeLabel(x.id), class: x.code ? classOf(x.code) : 'Not an account' }));
}

// ---------- TB coding: your own numbers for each account ----------
// The numbers above are the defaults. You can give any account a different 4-digit number; only the
// differences are saved. Source accounts (the banks and cards) are keyed "src:<account>".
const DEFAULT_CODES = Object.fromEntries(Object.values(CATEGORIES).map(x => [x.id, x.code]));
const DEFAULT_SOURCE_CODES = Object.fromEntries(Object.entries(SOURCE_ACCOUNTS).map(([k, v]) => [`src:${k}`, v.code]));
export const defaultCode = key => (key.startsWith('src:') ? DEFAULT_SOURCE_CODES[key] : DEFAULT_CODES[key]);

// Every account that holds a number, with the number it would have under a given coding.
function accountsWith(coding) {
  return [
    ...Object.values(CATEGORIES).filter(x => DEFAULT_CODES[x.id]).map(x => ({ key: x.id, name: x.name, code: coding[x.id] ?? DEFAULT_CODES[x.id] })),
    ...Object.entries(SOURCE_ACCOUNTS).map(([k, v]) => ({ key: `src:${k}`, name: v.name, code: coding[`src:${k}`] ?? DEFAULT_SOURCE_CODES[`src:${k}`] })),
    ...PLANNED.map(p => ({ key: `planned:${p.code}`, name: p.name, code: p.code })),
    ...SYSTEM_ACCOUNTS.map(a => ({ key: `system:${a.key}`, name: a.name, code: a.code })),
  ];
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
export function codingList(trips = [], coding = {}) {
  const open = new Set([0, ...trips.map(t => t.slot)]);
  const rows = [
    ...Object.values(CATEGORIES).filter(x => DEFAULT_CODES[x.id] && (x.group !== 'vacation' || open.has(x.slot)))
      .map(x => ({ key: x.id, code: x.code, name: x.id === 'review' ? 'Suspense (needs review)' : x.name, status: 'Active', editable: true })),
    ...Object.entries(SOURCE_ACCOUNTS).map(([k, v]) => ({ key: `src:${k}`, code: v.code, name: v.name, status: 'Active', editable: true })),
    ...PLANNED.map(p => ({ key: `planned:${p.code}`, code: p.code, name: p.name, status: 'Planned', editable: false })),
    ...SYSTEM_ACCOUNTS.map(a => ({ key: `system:${a.key}`, code: a.code, name: a.name, status: 'Active', editable: false })),
  ];
  return rows.map(r => ({ ...r, class: classOf(r.code), changed: r.key in coding })).sort((a, b) => a.code.localeCompare(b.code));
}
