// Parent accounts on the statements. An account with sub accounts under it shows the sum of everything beneath it,
// then its sub accounts follow, indented. A parent account that holds no money of its own (a heading) works the same.
// If a real account has money of its own as well as sub accounts, that shows on its own "(other)" line so nothing is hidden.
import { CATEGORIES, parentOf, headersAbove } from './categories.js';

const ancestorsOf = key => { const out = []; for (let at = parentOf(key); at && out.length < 5; at = parentOf(at)) out.push(at); return out; };

// Adds up objects that are keyed by month (or anything else): [{a: 1}, {a: 2}] -> {a: 3}.
export function addMaps(maps) {
  const out = {};
  for (const m of maps) for (const [k, v] of Object.entries(m ?? {})) out[k] = (out[k] ?? 0) + (v ?? 0);
  return out;
}

// rows: one section's rows in number order, each with { key, code, name }.
// rollup(list) makes the numbers for a parent from the rows under it; hasOwn(row) says whether a row has figures of its own.
// Returns entries: { kind: 'row' | 'parent' | 'own', key, code, name, data }.
export function nestRows(rows, { rollup, hasOwn }) {
  const below = key => rows.filter(r => r.key !== key && ancestorsOf(r.key).includes(key));
  const out = [], seen = new Set();
  for (const r of rows) {
    for (const hk of headersAbove(r.key)) {
      if (seen.has(hk)) continue;
      seen.add(hk);
      out.push({ kind: 'parent', key: hk, code: CATEGORIES[hk].code, name: CATEGORIES[hk].name, data: rollup(below(hk)) });
    }
    const kids = below(r.key);
    if (kids.length) {
      out.push({ kind: 'parent', key: r.key, code: r.code, name: r.name, data: rollup([r, ...kids]) });
      if (hasOwn(r)) out.push({ kind: 'own', key: r.key, code: '', name: `${r.name} (other)`, data: r });
    } else out.push({ kind: 'row', key: r.key, code: r.code, name: r.name, data: r });
  }
  return out;
}
