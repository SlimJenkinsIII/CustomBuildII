// Rules: "if the description contains X, it's category Y". First match wins; YOUR rules go first.
// Matching is whole-word and case-insensitive ("SHELL" matches "SHELL OIL 5744" but not "SHELLEY'S").
// Optional `sign: 'in' | 'out'` restricts a rule to money in or money out.
import { CATEGORIES, SOURCE_ROLES } from './categories.js';

// Paying off a credit card is not spending: it moves money from where you paid it (usually checking) to the card.
// On the card's own statement a payment is money in with "payment" or "thank you" in it. On the paying account it reads
// like "payment to Chase card" or "Amex autopay". When the other half hasn't been imported, these still file as a
// transfer (held in "transfers in transit" until it arrives) instead of cluttering Needs review.
const PAYMENT_WORDS = /payment|pymt|pmt|epay|autopay|thank you/i;
const CARD_WORDS = /\bcard\b|\bcrd\b|amex|american express|chase credit|credit card/i;
// A cash-out from the Venmo balance to your bank is money moving between your own accounts, never spending.
export const isVenmoCashOut = t => t.account === 'venmo' && /^VENMO TRANSFER TO BANK/.test(t.description);

export function isCardPayment(t) {
  if (!PAYMENT_WORDS.test(t.description)) return false;
  if (SOURCE_ROLES[t.account] === 'liability') return t.cents > 0;                 // money coming in to a card, worded as a payment
  return t.cents < 0 && CARD_WORDS.test(t.description);                            // money leaving a bank, worded as a card payment
}

const r = (category, sign, ...contains) => contains.map(text => ({ contains: text, category, ...(sign && { sign }) }));

// Gas stations and the chains that sell fuel. They file as gas (free cash) by default; if you turn on "split gas-station
// charges by amount" (Coding tab), small charges there are treated as convenience-store purchases instead. See fuel.js.
export const FUEL_MERCHANTS = ['SHELL OIL', 'SHELL', 'EXXON', 'CHEVRON', 'QUIKTRIP', 'QT', 'WAWA', 'SHEETZ', 'RACETRAC', 'CIRCLE K', 'SPEEDWAY', 'MURPHY USA',
  'MURPHY EXPRESS', 'MARATHON PETRO', 'BP', 'VALERO', 'SUNOCO', 'CITGO', 'TEXACO', 'PHILLIPS 66', 'CONOCO', 'LOVES', 'PILOT TRAVEL', 'FLYING J', 'CASEYS',
  'KWIK TRIP', 'BUC-EE', 'BUCEES', 'THORNTONS', 'STOP N GO'];

// Starter guesses. The real wording on YOUR statements will differ, so expect to add your own rules.
export const defaultRules = [
  ...r('income_paycheck', 'in', 'PAYROLL'),
  ...r('sub_streaming', 'out', 'NETFLIX', 'SPOTIFY', 'HULU', 'DISNEY PLUS', 'HBO MAX', 'YOUTUBE PREMIUM', 'APPLE MUSIC'),
  ...r('sub_software', 'out', 'MICROSOFT', 'ICLOUD', 'DROPBOX', 'ADOBE', 'OPENAI', 'GOOGLE ONE'),
  ...r('sub_gym', 'out', 'PLANET FITNESS', 'EQUINOX', 'LA FITNESS', 'ORANGETHEORY'),
  ...r('fixed_utilities', 'out', 'SPECTRUM', 'COMCAST', 'XFINITY', 'AT&T', 'VERIZON', 'T-MOBILE', 'CITY OF AUSTIN UTILITIES'),
  ...r('onetime_annual', 'out', 'ANNUAL MEMBERSHIP FEE', 'DMV', 'VEHICLE REGISTRATION'),
  ...r('free_groceries', 'out', 'WHOLEFDS', 'WHOLE FOODS', 'TRADER JOE', 'HEB', 'KROGER', 'SAFEWAY', 'COSTCO', 'ALDI'),
  ...r('free_coffee', 'out', 'BLUE BOTTLE', 'STARBUCKS', 'PEETS'),
  ...r('free_restaurants', 'out', 'CHIPOTLE', 'DOORDASH', 'UBER EATS', 'GRUBHUB', 'MCDONALDS'),
  ...r('free_alcohol', 'out', 'TOTAL WINE', 'SPECS', 'BEVMO'),
  ...r('free_transport', 'out', ...FUEL_MERCHANTS, 'UBER', 'LYFT'),
  ...r('fixed_rent', 'out', 'APARTMENTS', 'PROPERTY MANAGEMENT', 'LEASING'),
  ...r('free_shopping', 'out', 'AMAZON', 'AMZN MKTP', 'TARGET', 'ULTA BEAUTY'),
  // Vacation spending lands in "no trip yet" (block 7000); trips.js moves it into a trip by date.
  ...r('vac0_travel', 'out', 'DELTA AIR LINES', 'UNITED AIRLINES', 'SOUTHWEST AIRLINES', 'AMERICAN AIRLINES'),
  ...r('vac0_lodging', 'out', 'AIRBNB', 'MARRIOTT', 'HILTON', 'HYATT', 'VRBO', 'HOTELS.COM'),
  ...r('vac0_travel', 'out', 'EXPEDIA'),
  ...r('other_interest', 'in', 'INTEREST PAYMENT', 'INTEREST PAID', 'INTEREST EARNED'),
  ...r('other_interest_exp', 'out', 'INTEREST CHARGE', 'FINANCE CHARGE'),
  ...r('save_chase', 'out', 'TRANSFER TO SAV'),
  ...r('save_chase', 'in', 'TRANSFER FROM SAV'),
];

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matchers = new Map();
function matcher(text) {
  if (!matchers.has(text)) matchers.set(text, new RegExp(`(^|[^A-Z0-9])${esc(text.toUpperCase())}([^A-Z0-9]|$)`));
  return matchers.get(text);
}

export function ruleMatches(rule, t) {
  if (rule.sign === 'in' && t.cents <= 0) return false;
  if (rule.sign === 'out' && t.cents >= 0) return false;
  return matcher(rule.contains).test(t.description.toUpperCase());
}

// savingsAccounts maps an account name to the savings category it represents, e.g.
//   { 'chase-savings': 'save_chase' }.  A matched transfer INTO such an account counts as a
// savings contribution on the sending side; the receiving side is ignored so it isn't counted twice.
export function categorize(transactions, {
  userRules = [], rules = defaultRules, savingsAccounts = {}, reimbursePromptCents = 10000,
} = {}) {
  const byId = new Map(transactions.map(t => [t.id, t]));
  const allRules = [...userRules, ...rules];
  for (const rule of allRules) {
    if (!CATEGORIES[rule.category]) throw new Error(`Rule "${rule.contains}" uses unknown category "${rule.category}"`);
  }

  return transactions.map(t => {
    let category, why;
    if (t.transfer === 'matched') {
      const other = byId.get(t.pairId);
      const savingsCat = other && t.cents < 0 ? savingsAccounts[other.account] : undefined;
      category = savingsCat ?? 'transfer';
      why = savingsCat ? `transfer into ${other.account}` : 'matched transfer';
    } else if (t.transfer === 'unmatched' && (isCardPayment(t) || isVenmoCashOut(t))) {
      category = 'transfer';
      why = isVenmoCashOut(t) ? 'Venmo cash-out (the bank deposit isn’t imported yet)' : 'card payment (the other account isn’t imported yet)';
    } else {
      const rule = allRules.find(x => ruleMatches(x, t));
      if (rule) { category = rule.category; why = `rule: ${rule.contains}`; }
      else { category = 'review'; why = t.transfer ? 'transfer-like, needs review' : 'no rule matched'; }
    }
    const out = { ...t, category, categoryReason: why };
    // Big dinners/drinks you probably paid for the group: ask instead of assuming.
    if ((category === 'free_restaurants' || category === 'free_alcohol') && t.cents <= -reimbursePromptCents) {
      out.askReimbursement = true;
    }
    return out;
  });
}
