import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatement } from '../app/src/parsers.js';
import { withIds } from '../app/src/ledger.js';
import { matchTransfers } from '../app/src/transfers.js';
import { categorize } from '../app/src/rules.js';
import { monthlyMatrix } from '../app/src/insights.js';

const load = f => withIds(parseStatement(readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8')).transactions);
const FILES = ['FAKE-jan-feb-chase-checking.csv', 'FAKE-jan-feb-chase-card.csv', 'FAKE-jan-feb-amex.csv',
  'FAKE-chase-checking.csv', 'FAKE-chase-card.csv', 'FAKE-amex.csv'];
const all = () => categorize(matchTransfers(FILES.flatMap(load)));
const t = (date, cents, category) => ({ id: date + cents + category, date, cents, category, description: 'x', account: 'a' });
const line = (m, pred) => m.lines.find(pred);
const row = (m, id) => line(m, l => l.kind === 'row' && l.id === id);
const net = (m, label) => line(m, l => l.kind === 'net' && l.label === label);

test('twelve month columns, and only months with data count toward averages', () => {
  const m = monthlyMatrix(all(), '2026');
  assert.equal(m.months.length, 12);
  assert.equal(m.dataMonths, 3);
  assert.deepEqual(m.months.filter(ym => m.hasData[ym]), ['2026-01', '2026-02', '2026-03']);
});

test('income and expenses land in the right month with the right sign', () => {
  const m = monthlyMatrix(all(), '2026');
  assert.equal(row(m, 'income_paycheck').byMonth['2026-01'], 420000);   // two paychecks
  assert.equal(row(m, 'income_paycheck').byMonth['2026-03'], 210000);
  assert.equal(row(m, 'fixed_rent').byMonth['2026-02'], 140000);
  assert.equal(row(m, 'onetime_annual').byMonth['2026-01'], -69500);    // annual card fee: a loss, so bracketed
  assert.equal(row(m, 'sub_streaming').total, 1549 * 3 + 1199 * 2);      // Netflix x3, Spotify x2
});

test('card payments and own-account transfers never show up as income or spending', () => {
  const m = monthlyMatrix(all(), '2026');
  assert.equal(m.lines.find(l => l.id === 'transfer'), undefined);
  const income = line(m, l => l.kind === 'subtotal' && l.label === 'Total income');
  assert.equal(income.total, 420000 * 2 + 210000);
});

test('savings transfers appear under savings and reduce what is left in checking', () => {
  const m = monthlyMatrix(all(), '2026');
  assert.equal(row(m, 'save_chase').byMonth['2026-01'], 40000);
  const before = net(m, 'Net income (loss)'), left = net(m, 'Left after savings moved');
  assert.equal(left.byMonth['2026-01'], before.byMonth['2026-01'] - 40000);
});

test('net, running total and year total all agree', () => {
  const m = monthlyMatrix(all(), '2026');
  const before = net(m, 'Net income (loss)');
  const running = line(m, l => l.kind === 'running');
  assert.equal(before.total, m.months.reduce((s, ym) => s + before.byMonth[ym], 0));
  assert.equal(running.byMonth['2026-03'], before.total);               // last data month equals the year total
  assert.equal(running.byMonth['2026-01'], before.byMonth['2026-01']);
  assert.equal(running.byMonth['2026-04'], null);                       // no data yet, so blank
});

test('refunds reduce a row, and review lines are shown net', () => {
  const m = monthlyMatrix([t('2026-05-02', -5000, 'free_shopping'), t('2026-05-03', 2000, 'free_shopping'),
    t('2026-05-04', -3000, 'review'), t('2026-05-05', 1000, 'review')], '2026');
  assert.equal(row(m, 'free_shopping').byMonth['2026-05'], 3000);
  assert.equal(row(m, 'review').byMonth['2026-05'], 2000);
});

test('other years are ignored and empty accounts are hidden', () => {
  const m = monthlyMatrix([t('2025-12-31', -9999, 'free_gifts'), t('2026-01-01', -100, 'free_coffee')], '2026');
  assert.equal(row(m, 'free_gifts'), undefined);
  assert.equal(row(m, 'free_coffee').total, 100);
});

test('averages skip a month still in progress', () => {
  const full = monthlyMatrix(all(), '2026');                       // no as-of date: March counts like any month
  const partial = monthlyMatrix(all(), '2026', '2026-03-09');      // data stops on the 9th
  assert.equal(partial.partialMonth, '2026-03');
  assert.equal(partial.fullMonthCount, 2);
  assert.equal(row(partial, 'fixed_rent').avg, 140000);            // (1,400 + 1,400) / 2 full months
  assert.equal(row(full, 'fixed_rent').avg, Math.round(280000 / 3));
  assert.equal(row(partial, 'fixed_rent').total, 280000);          // the year total still includes everything
});

test('a finished month is not partial', () => {
  assert.equal(monthlyMatrix(all(), '2026', '2026-03-31').partialMonth, null);
  assert.equal(monthlyMatrix(all(), '2026', '2026-04-02').partialMonth, null);
});

test('net operating income = income less fixed, subscriptions, free cash and review; net income then adds the 6000s and 7000', () => {
  const m = monthlyMatrix(all(), '2026');
  const sub = label => m.lines.find(l => l.kind === 'subtotal' && l.label === label)?.byMonth['2026-01'] ?? 0;
  const review = row(m, 'review').byMonth['2026-01'];
  const netOp = net(m, 'Net operating income').byMonth['2026-01'];
  assert.equal(netOp, sub('Total income') - sub('Total fixed monthly expenses') - sub('Total subscriptions') - sub('Total free cash') - review);
  const netIncome = net(m, 'Net income (loss)').byMonth['2026-01'];
  assert.equal(netIncome, netOp + sub('Total other income & loss') + sub('Total vacations'));
  assert.equal(row(m, 'vac0_travel').byMonth['2026-01'], -41230);      // the made-up January flight
});

test('table sections appear in GL-code order', () => {
  const m = monthlyMatrix(all(), '2026');
  const headers = m.lines.filter(l => l.kind === 'header').map(l => l.code.slice(0, 4));
  assert.deepEqual(headers.slice(0, 7), ['4000', '5100', '5200', '5400', '6000', '7000', '1000']);
});
