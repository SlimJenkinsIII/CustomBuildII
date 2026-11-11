import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, MAX_TRIPS, VAC_KINDS, applyTripNames, selectableCategories, chartOfAccounts, codeLabel, migrateCategory, parentOf, depthOf } from '../app/src/categories.js';
import { addTrip, updateTrip, removeTrip, nextSlot, tripFor, assignTrips, validateTrip } from '../app/src/trips.js';
import { categorize } from '../app/src/rules.js';
import { plannedFreeCash, monthSummary } from '../app/src/budget.js';
import { freeSpend } from '../app/src/budget.js';

const trip = (name, start, end) => ({ name, start, end });
const tx = (date, cents, description) => ({ id: date + description, date, cents, description, account: 'amex' });

test('each trip is a parent account (7100, 7200...) with the same five accounts under it', () => {
  assert.equal(MAX_TRIPS, 9);
  assert.deepEqual(VAC_KINDS.map(k => k[1]), ['Travel', 'Lodging', 'Food & drinks', 'Entertainment', 'Purchases']);
  assert.equal(CATEGORIES.vac1.code, '7100');
  assert.equal(CATEGORIES.vac1.group, 'header');                        // holds no money of its own
  assert.equal(CATEGORIES.vac1_travel.code, '7110');
  assert.equal(CATEGORIES.vac1_lodging.code, '7120');
  assert.equal(CATEGORIES.vac1_food.code, '7130');
  assert.equal(CATEGORIES.vac1_entertainment.code, '7140');
  assert.equal(CATEGORIES.vac1_purchases.code, '7150');
  assert.equal(CATEGORIES.vac2_lodging.code, '7220');
  assert.equal(CATEGORIES.vac9_purchases.code, '7950');
  assert.equal(CATEGORIES.vac0.code, '7000');                           // parent 7000 = no trip yet
  assert.equal(CATEGORIES.vac0_lodging.code, '7020');
  assert.equal(VAC_KINDS.length * (MAX_TRIPS + 1), Object.values(CATEGORIES).filter(c => c.group === 'vacation').length);
  assert.equal(parentOf('vac3_food'), 'vac3');                         // every one of them sits under its trip
  assert.equal(depthOf('vac3_food'), 1);
});

test('older saved choices fold into the five accounts', () => {
  assert.equal(migrateCategory('vac1_flights'), 'vac1_travel');
  assert.equal(migrateCategory('vac2_transport'), 'vac2_travel');
  assert.equal(migrateCategory('vac1_shopping'), 'vac1_purchases');
  assert.equal(migrateCategory('vac0_other'), 'vac0_purchases');
  assert.equal(migrateCategory('vac1_lodging'), 'vac1_lodging');       // already one of the five
  assert.equal(migrateCategory('free_groceries'), 'free_groceries');
  assert.equal(migrateCategory(undefined), undefined);
});

test('trips take the next free block, up to nine', () => {
  let trips = [];
  trips = addTrip(trips, trip('Lisbon', '2026-05-01', '2026-05-09'));
  trips = addTrip(trips, trip('Tahoe', '2026-12-20', '2026-12-27'));
  assert.deepEqual(trips.map(t => t.slot), [1, 2]);
  trips = removeTrip(trips, 1);
  assert.equal(nextSlot(trips), 1);                                    // the freed block is reused
  for (let i = 0; i < 8; i++) trips = addTrip(trips, trip(`T${i}`, '2027-01-01', '2027-01-02'));
  assert.equal(nextSlot(trips), null);
  assert.throws(() => addTrip(trips, trip('One too many', '2027-02-01', '2027-02-02')), /room for 9 trips/);
});

test('trip details are checked', () => {
  assert.throws(() => validateTrip(trip('', '2026-05-01', '2026-05-02')), /name/);
  assert.throws(() => validateTrip(trip('X', '', '2026-05-02')), /start and end date/);
  assert.throws(() => validateTrip(trip('X', '2026-05-09', '2026-05-01')), /cannot end before/);
});

test('a charge goes to the trip it falls inside, or the nearest one within the booking window', () => {
  const trips = addTrip(addTrip([], trip('Lisbon', '2026-05-01', '2026-05-09')), trip('Tahoe', '2026-12-20', '2026-12-27'));
  assert.equal(tripFor('2026-05-05', trips).name, 'Lisbon');           // during
  assert.equal(tripFor('2026-03-28', trips).name, 'Lisbon');           // flight booked 34 days ahead
  assert.equal(tripFor('2026-05-15', trips).name, 'Lisbon');           // charge posts late
  assert.equal(tripFor('2026-08-01', trips), null);                    // nowhere near either trip
  assert.equal(tripFor('2026-11-30', trips).name, 'Tahoe');
});

test('vacation charges move from "no trip yet" into the matching trip, nothing else changes', () => {
  const trips = addTrip([], trip('Lisbon', '2026-05-01', '2026-05-09'));
  const rows = assignTrips(categorize([
    tx('2026-03-28', -41230, 'DELTA AIR LINES 0067'), tx('2026-05-03', -90000, 'MARRIOTT LISBON'),
    tx('2026-08-01', -30000, 'AIRBNB HMBBX'), tx('2026-05-04', -4500, 'CHIPOTLE')]), trips);
  assert.equal(rows[0].category, 'vac1_travel');
  assert.equal(rows[1].category, 'vac1_lodging');
  assert.equal(rows[2].category, 'vac0_lodging');                      // too far from the trip: stays unassigned
  assert.equal(rows[3].category, 'free_restaurants');                  // dinner on the trip is still free cash
});

test('with no trips, vacation spending stays in block 7000', () => {
  const rows = assignTrips(categorize([tx('2026-03-28', -41230, 'DELTA AIR LINES 0067')]), []);
  assert.equal(rows[0].category, 'vac0_travel');
});

test('trip names flow into the account names, and the chart only lists blocks that exist', () => {
  const trips = addTrip([], trip('Lisbon', '2026-05-01', '2026-05-09'));
  applyTripNames(trips);
  assert.equal(codeLabel('vac1_lodging'), '7120 Lisbon · Lodging');
  assert.equal(CATEGORIES.vac1.name, 'Lisbon');                          // the parent is the trip's name
  assert.equal(codeLabel('vac2_lodging'), '7220 Trip 2 · Lodging');
  const codes = chartOfAccounts(trips).map(a => a.code);
  assert.ok(codes.includes('7100') && codes.includes('7110') && codes.includes('7010'));
  assert.ok(!codes.includes('7200') && !codes.includes('7210'));
  assert.ok(selectableCategories(trips).some(c => c.id === 'vac1_food'));
  assert.ok(!selectableCategories(trips).some(c => c.id === 'vac2_food'));
  applyTripNames([]);                                                  // reset for other tests
  assert.equal(codeLabel('vac1_lodging'), '7120 Trip 1 · Lodging');
});

test('the vacation set-aside comes out of free cash but trips never count as weekly spending', () => {
  const plan = { income: 600000, vacation: 20000, planned: { fixed_rent: 200000 } };
  assert.equal(plannedFreeCash(plan), 600000 - 20000 - 200000);
  assert.throws(() => plannedFreeCash({ income: 1, vacation: -5, planned: {} }), /Vacation/);
  const rows = [{ ...tx('2026-03-01', -41230, 'DELTA'), category: 'vac1_travel' }];
  assert.equal(freeSpend(rows[0]), 0);
  assert.equal(monthSummary(rows, plan, '2026-03').vacation.actual, 41230);
  assert.equal(monthSummary(rows, plan, '2026-03').vacation.planned, 20000);
});

test('a trip can be renamed and its dates changed, with the same checks as adding one', () => {
  let trips = addTrip([], trip('Lisbon', '2026-05-01', '2026-05-09'));
  trips = updateTrip(trips, 1, { name: '  Lisbon in May  ' });
  assert.equal(trips[0].name, 'Lisbon in May');
  assert.equal(trips[0].start, '2026-05-01');                              // dates untouched by a rename
  trips = updateTrip(trips, 1, { start: '2026-05-03', end: '2026-05-12' });
  assert.deepEqual([trips[0].start, trips[0].end], ['2026-05-03', '2026-05-12']);
  assert.throws(() => updateTrip(trips, 1, { name: '   ' }), /name/i);
  assert.throws(() => updateTrip(trips, 1, { end: '2026-04-01' }), /cannot end before/);
  assert.throws(() => updateTrip(trips, 7, { name: 'x' }), /doesn’t exist/);
  applyTripNames(trips);
  assert.equal(CATEGORIES.vac1.name, 'Lisbon in May');                      // the 7100 account shows the new name
  applyTripNames([]);
});

test('once a trip exists, "no trip yet" (7000) is not offered as a choice, so it cannot be picked by mistake', () => {
  const none = selectableCategories([]);
  assert.ok(none.some(c => c.id === 'vac0_travel'));                      // before any trip, it is the only place for vacation spending
  const trips = addTrip([], trip('Lisbon', '2026-05-01', '2026-05-09'));
  const withTrip = selectableCategories(trips);
  assert.ok(!withTrip.some(c => c.id.startsWith('vac0_')));
  assert.ok(withTrip.some(c => c.id === 'vac1_travel'));                  // the trip's own five are there
  assert.equal(withTrip.filter(c => c.class === 'Vacations').length, 5);
  // the accounts themselves are untouched, so charges already filed there keep their place on the statements
  assert.equal(CATEGORIES.vac0_travel.code, '7010');
});
