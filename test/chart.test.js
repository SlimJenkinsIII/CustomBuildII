import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, SOURCE_ACCOUNTS, chartOfAccounts, classOf, codeLabel, sourceLabel } from '../app/src/categories.js';
import { categorize } from '../app/src/rules.js';
import { monthlyMatrix } from '../app/src/insights.js';
import { freeSpend } from '../app/src/budget.js';

const tx = (date, cents, description, account = 'chase-checking') =>
  ({ id: date + cents + description, date, cents, description, account });

test('every account has a unique 4-digit code', () => {
  const codes = chartOfAccounts().map(a => a.code);
  assert.ok(codes.every(c => /^\d{4}$/.test(c)));
  assert.equal(new Set(codes).size, codes.length);
});

test('codes sit in the right range for what the account is', () => {
  const first = id => CATEGORIES[id].code[0];
  for (const c of Object.values(CATEGORIES)) {
    if (c.group === 'income') assert.equal(c.code[0], '4', c.id);
    if (['fixed', 'subscriptions', 'free'].includes(c.group)) assert.equal(c.code[0], '5', c.id);
    if (c.group === 'onetime') assert.equal(c.code[0], '6', c.id);    // one-time purchases live in the 6000s
    if (c.group === 'vacation') assert.ok(c.code >= '7000' && c.code <= '7999', c.id);
    if (c.group === 'savings') assert.equal(c.code[0], '1', c.id);   // savings are assets, not spending
    if (c.group === 'other') assert.equal(c.code[0], '6', c.id);
  }
  assert.equal(first('review'), '1');                                 // suspense
  assert.equal(CATEGORIES.review.code, '1900');
  assert.equal(CATEGORIES.transfer.code, null);                       // ignored, so no account
  for (const a of Object.values(SOURCE_ACCOUNTS)) assert.ok(['1', '2'].includes(a.code[0]));
  assert.equal(SOURCE_ACCOUNTS['chase-card'].code[0], '2');           // cards are liabilities
});

test('accounts are labelled with their class and sorted by code', () => {
  const chart = chartOfAccounts();
  assert.deepEqual(chart.map(a => a.code), [...chart.map(a => a.code)].sort());
  assert.equal(classOf('1000'), 'Assets');
  assert.equal(classOf('2010'), 'Liabilities');
  assert.equal(classOf('3100'), 'Equity');
  assert.equal(classOf('4000'), 'Revenue');
  assert.equal(classOf('5430'), 'Expenses');
  assert.equal(classOf('6010'), 'Other income / loss');
  assert.equal(classOf('7000'), 'Vacations');
  assert.ok(chart.every(a => a.status === 'Active'));          // no reserved placeholders: you build the chart you want
});

test('labels show code then name', () => {
  assert.equal(codeLabel('free_groceries'), '5430 Groceries');
  assert.equal(codeLabel('transfer'), 'Transfer (not spending)');
  assert.equal(codeLabel('onetime_annual'), '6100 One-time purchases & annual fees');
  assert.equal(codeLabel('vac0_flights'), '7020 No trip yet · Flights');
  assert.equal(codeLabel('vac1_lodging'), '7110 Trip 1 · Lodging');
  assert.equal(codeLabel('vac3_food'), '7330 Trip 3 · Food & drink');
  assert.equal(sourceLabel('amex'), '2010 Amex card');
  assert.equal(sourceLabel('mystery'), 'mystery');
});

test('interest received and finance charges go to the 6000 accounts', () => {
  const [earned, charged] = categorize([tx('2026-01-31', 412, 'INTEREST PAYMENT'), tx('2026-01-31', -2500, 'PURCHASE FINANCE CHARGE', 'amex')]);
  assert.equal(earned.category, 'other_interest');
  assert.equal(charged.category, 'other_interest_exp');
});

test('below the operating line: other income & loss, one-time purchases and vacations are in brackets and flow into net income', () => {
  const rows = categorize([
    tx('2026-01-05', 210000, 'ACME CORP PAYROLL'), tx('2026-01-10', -30000, 'HEB #404'),
    tx('2026-01-31', 412, 'INTEREST PAYMENT'), tx('2026-01-31', -2500, 'FINANCE CHARGE', 'amex'),
    tx('2026-01-20', -69500, 'ANNUAL MEMBERSHIP FEE', 'amex'), tx('2026-01-25', -41230, 'DELTA AIR LINES 0067', 'amex')]);
  const m = monthlyMatrix(rows, '2026');
  const line = pred => m.lines.find(pred);
  assert.equal(line(l => l.kind === 'header' && l.label === 'Other income & loss').code, '6000\u20136199');
  assert.equal(line(l => l.id === 'other_interest').byMonth['2026-01'], 412);
  assert.equal(line(l => l.id === 'other_interest_exp').byMonth['2026-01'], -2500);   // a loss shows negative
  assert.equal(line(l => l.id === 'onetime_annual').code, '6100');
  assert.equal(line(l => l.id === 'onetime_annual').byMonth['2026-01'], -69500);
  assert.equal(line(l => l.id === 'vac0_flights').code, '7020');
  assert.equal(line(l => l.id === 'vac0_flights').byMonth['2026-01'], -41230);
  const netOp = line(l => l.label === 'Net operating income');
  const netIncome = line(l => l.label === 'Net income (loss)');
  assert.equal(netOp.byMonth['2026-01'], 210000 - 30000);                           // untouched by anything below the line
  assert.equal(netIncome.byMonth['2026-01'], 210000 - 30000 + 412 - 2500 - 69500 - 41230);
});

test('vacations and one-time purchases stay out of weekly free cash', () => {
  const [flight, fee] = categorize([tx('2026-03-02', -41230, 'DELTA AIR LINES 0067', 'amex'), tx('2026-03-03', -69500, 'ANNUAL MEMBERSHIP FEE', 'amex')]);
  assert.equal(flight.category, 'vac0_flights');
  assert.equal(fee.category, 'onetime_annual');
  assert.equal(freeSpend(flight), 0);
  assert.equal(freeSpend(fee), 0);
});

test('matrix rows carry GL codes and each group is in code order', () => {
  const rows = categorize([tx('2026-01-02', -500, 'STARBUCKS'), tx('2026-01-03', -4000, 'HEB #404'), tx('2026-01-04', -900, 'TOTAL WINE')]);
  const m = monthlyMatrix(rows, '2026');
  const free = m.lines.filter(l => l.kind === 'row' && l.group === 'free');
  assert.deepEqual(free.map(l => l.code), ['5410', '5420', '5430']);
  assert.equal(m.lines.find(l => l.kind === 'header' && l.label === 'Free cash').code, '5400\u20135499');
});
