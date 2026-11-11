// Trips: each one owns a hundred-block of vacation accounts (7100, 7200 ... 7900).
// Vacation spending is first filed under "no trip yet" (block 7000); assignTrips() moves it into a trip
// when its date falls in that trip's window. Anything you assign by hand is never moved.
import { MAX_TRIPS } from './categories.js';

const LEAD_DAYS = 45;   // flights and hotels are often bought well before the trip
const TRAIL_DAYS = 10;  // and charges post a little after it

const dayIndex = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

export function nextSlot(trips) {
  for (let slot = 1; slot <= MAX_TRIPS; slot++) if (!trips.some(t => t.slot === slot)) return slot;
  return null;
}

export function validateTrip({ name, start, end }) {
  if (!String(name ?? '').trim()) throw new Error('Give the trip a name.');
  if (!isDate(start) || !isDate(end)) throw new Error('Choose a start and end date.');
  if (end < start) throw new Error('The trip cannot end before it starts.');
}

export function addTrip(trips, trip) {
  validateTrip(trip);
  const slot = nextSlot(trips);
  if (slot === null) throw new Error(`The numbering has room for ${MAX_TRIPS} trips (7100 to 7900).`);
  return [...trips, { slot, name: trip.name.trim(), start: trip.start, end: trip.end }].sort((a, b) => a.slot - b.slot);
}

// Changes a trip's name or dates. Its accounts follow: the name shows on 7100, and the dates decide which charges belong to it.
export function updateTrip(trips, slot, changes) {
  const cur = trips.find(t => t.slot === slot);
  if (!cur) throw new Error('That trip doesn’t exist.');
  const next = { name: String(changes.name ?? cur.name).trim(), start: changes.start ?? cur.start, end: changes.end ?? cur.end };
  validateTrip(next);
  return trips.map(t => (t.slot === slot ? { slot, ...next } : t));
}

export const removeTrip = (trips, slot) => trips.filter(t => t.slot !== slot);

// Which trip does a date belong to? A trip whose dates contain it wins; otherwise the nearest start inside the window.
export function tripFor(date, trips) {
  const d = dayIndex(date);
  const inside = trips.filter(t => d >= dayIndex(t.start) && d <= dayIndex(t.end));
  if (inside.length) return inside.sort((a, b) => a.start.localeCompare(b.start))[0];
  const near = trips
    .filter(t => d >= dayIndex(t.start) - LEAD_DAYS && d <= dayIndex(t.end) + TRAIL_DAYS)
    .sort((a, b) => Math.abs(d - dayIndex(a.start)) - Math.abs(d - dayIndex(b.start)));
  return near[0] ?? null;
}

const UNASSIGNED = /^vac0_(.+)$/;
export function assignTrips(transactions, trips) {
  if (!trips.length) return transactions;
  return transactions.map(t => {
    const m = UNASSIGNED.exec(t.category);
    if (!m) return t;
    const trip = tripFor(t.date, trips);
    return trip ? { ...t, category: `vac${trip.slot}_${m[1]}`, categoryReason: `${t.categoryReason}; trip: ${trip.name}` } : t;
  });
}
