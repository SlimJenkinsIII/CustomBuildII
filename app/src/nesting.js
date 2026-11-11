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
// ghosts: parent accounts to show even when nothing is under them yet ({ key, code, name }), so your main accounts are always there.
// Returns entries: { kind: 'row' | 'parent' | 'own', key, code, name, data, ancestors }. `ancestors` lists what each entry sits under,
// nearest first (for an "(other)" line it starts with its own parent), so a statement can hide whatever is folded away.
export function nestRows(rows, { rollup, hasOwn, ghosts = [] }) {
  const all = [...rows];
  for (const g of ghosts) {
    if (all.some(r => r.key === g.key)) continue;
    const at = all.findIndex(r => r.code > g.code);
    all.splice(at < 0 ? all.length : at, 0, { ...g, ghost: true });
  }
  const below = key => rows.filter(r => r.key !== key && ancestorsOf(r.key).includes(key));
  const out = [], seen = new Set();
  const parent = (key, code, name, list) => { seen.add(key); out.push({ kind: 'parent', key, code, name, data: rollup(list), ancestors: ancestorsOf(key) }); };
  for (const r of all) {
    for (const hk of headersAbove(r.key)) if (!seen.has(hk)) parent(hk, CATEGORIES[hk].code, CATEGORIES[hk].name, below(hk));
    if (r.ghost) {
      if (seen.has(r.key)) continue;
      if (r.leaf && !below(r.key).length) { seen.add(r.key); out.push({ kind: 'row', key: r.key, code: r.code, name: r.name, data: { ...rollup([]), key: r.key, code: r.code, name: r.name }, ancestors: ancestorsOf(r.key) }); }
      else parent(r.key, r.code, r.name, below(r.key));
      continue;
    }
    const kids = below(r.key);
    if (kids.length) {
      parent(r.key, r.code, r.name, [r, ...kids]);
      if (hasOwn(r)) out.push({ kind: 'own', key: r.key, code: '', name: `${r.name} (other)`, data: r, ancestors: [r.key, ...ancestorsOf(r.key)] });
    } else out.push({ kind: 'row', key: r.key, code: r.code, name: r.name, data: r, ancestors: ancestorsOf(r.key) });
  }
  return out;
}

// True when something is folded away above this entry.
export const isHidden = (entry, isOpen) => entry.ancestors.some(a => !isOpen(a));
