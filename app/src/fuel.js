// Gas stations sell fuel and snacks under one name, so the name can't tell them apart but the amount mostly can:
// a fill-up is big, a drink and a bag of chips is small. When switched on, a charge at a gas station under your cutoff files
// as a convenience-store purchase, and anything at or over it stays as gas. Your choice on any single charge still wins.
import { FUEL_MERCHANTS } from './rules.js';

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FUEL = new RegExp(`(^|[^A-Z0-9])(${FUEL_MERCHANTS.map(escape).join('|')})($|[^A-Z0-9])`);

export const isFuelStop = description => FUEL.test(String(description ?? '').toUpperCase());

export const DEFAULT_FUEL = { on: false, cutoff: 2500, below: '' };

export function cleanFuel(raw, isCategory = () => true) {
  const out = { ...DEFAULT_FUEL };
  if (!raw || typeof raw !== 'object') return out;
  if (Number.isInteger(raw.cutoff) && raw.cutoff >= 100 && raw.cutoff <= 100000) out.cutoff = raw.cutoff;
  if (typeof raw.below === 'string' && isCategory(raw.below)) out.below = raw.below;
  out.on = raw.on === true && !!out.below;                                  // can't be on without somewhere to send the small charges
  return out;
}

// Only charges the app had filed as gas are looked at, so something you or a rule put elsewhere is left alone.
export function applyFuelSplit(txs, fuel, gasCategory = 'free_transport') {
  if (!fuel?.on || !fuel.below) return txs;
  return txs.map(t => (t.cents < 0 && -t.cents < fuel.cutoff && t.category === gasCategory && isFuelStop(t.description)
    ? { ...t, category: fuel.below, categoryReason: `gas station, under $${(fuel.cutoff / 100).toFixed(0)}` } : t));
}
