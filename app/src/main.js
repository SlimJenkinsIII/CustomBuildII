import { parseStatement, toCents } from './parsers.js';
import { withIds, mergeTransactions } from './ledger.js';
import { matchTransfers } from './transfers.js';
import { categorize } from './rules.js';
import { CATEGORIES, SOURCE_ACCOUNTS, codeLabel, sourceLabel, applyTripNames, selectableCategories, applyCoding, setCode, cleanCoding, codingList, applyNames, setName, cleanNames, applyCustoms, cleanCustoms, addSub, removeSub, applyRemoved, cleanRemoved, removeAccount, restoreAccount, removeTargets, removedList, resolveCategory, isRemoved, MAX_TRIPS } from './categories.js';
import { weekSummary, weeklyRunning, monthSummary, startOfWeek, addDays, daysBetween, monthOf, plannedFreeCash, validatePlan } from './budget.js';
import { asOfDate, monthPace, habits, attention, coverage, monthlyMatrix, completeWeeks, periodWindow, periodTotals, compareTotals, cumulativeSeries, categoryBreakdownRange, topPurchasesRange, diningOutRange, staleAccounts, defaultMonth } from './insights.js';
import { assignTrips, addTrip, removeTrip } from './trips.js';
import { trialBalance, balanceSheet, tieOut, openingAccounts, cleanOpening, countBeforeOpening, DEFAULT_OPENING_DATE } from './journal.js';
import { createVault, seal, unlock } from './vault.js';
import { memoryStorage, indexedDbStorage } from './storage.js';
import { samplePlan } from './plan.sample.js';
import { isTestAddress } from './host.js';
import { dummySnapshot } from './dummy.js';

let plan = samplePlan; // replaced by your own plan once you edit it in Settings (or load saved data)

// The preview page sets this flag: it keeps everything in memory and never saves.
const PREVIEW = typeof window !== 'undefined' && window.__PREVIEW__ === true;
const storage = PREVIEW ? memoryStorage() : indexedDbStorage();

// ---------- state ----------
// Saved (encrypted): raw statements, your category choices, trips, plan, TB coding. Everything else is derived.
const state = {
  raw: [], overrides: {}, trips: [], coding: {}, names: {}, customs: [], removed: {},
  txs: [], ym: null, year: null, month: '', tab: 'budget', fsPage: 'tb', returnTo: null, period: '4w',
  gl: { cat: '', ym: '', q: '', week: '', ask: false, acct: '', from: '', to: '' },
  tbView: 'bal', tie: '', opening: { date: DEFAULT_OPENING_DATE, balances: {} },
  vault: null, envelope: null, locked: false, save: 'idle', persisted: false,
  demo: false, demoAsk: false, stash: null, settingsScreen: 'home',
};

// ---------- formatting ----------
const MINUS = '−';
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = c => usd0.format(Math.abs(c) / 100);
const signed = c => (c > 0 ? '+' : c < 0 ? MINUS : '') + money(c);
const money2 = c => (c < 0 ? MINUS : '') + usd2.format(Math.abs(c) / 100);
const dateOf = iso => new Date(iso + 'T00:00:00Z');
const fmtDate = iso => dateOf(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtMonth = ym => dateOf(ym + '-01').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------- tiny DOM helpers (text only, never innerHTML) ----------
const SVG_NS = 'http://www.w3.org/2000/svg';
function make(ns, tag, props = {}, ...kids) {
  const n = ns ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.setAttribute('class', v);
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) n.append(kid);
  return n;
}
const h = (tag, props, ...kids) => make(false, tag, props, ...kids);
const s = (tag, props, ...kids) => make(true, tag, props, ...kids);
const $ = id => document.getElementById(id);
const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter(Boolean));

// ---------- data ----------
function recompute() {
  applyCustoms(state.customs);
  applyNames(state.names);
  state.removed = cleanRemoved(state.removed);
  applyRemoved(state.removed);
  applyCoding(state.coding);
  applyTripNames(state.trips);
  const auto = assignTrips(categorize(matchTransfers(state.raw)), state.trips);
  state.txs = auto.map(t => {
    const pick = state.overrides[t.id];
    const out = pick && CATEGORIES[pick] ? { ...t, category: pick, categoryReason: 'your choice', chosen: true } : t;
    const home = resolveCategory(out.category);
    return home === out.category ? out : { ...out, category: home };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const months = [...new Set(state.txs.map(t => monthOf(t.date)))].sort();
  if (!months.includes(state.ym)) state.ym = defaultMonth(state.txs);
  const years = [...new Set(months.map(m => m.slice(0, 4)))];
  if (!years.includes(state.year)) state.year = years[years.length - 1] ?? null;
}

async function importFiles(files) {
  if (state.demo) { $('status').textContent = 'Turn off dummy numbers (Settings) before adding statements.'; return; }
  let added = 0, skipped = 0;
  try {
    for (const file of files) {
      let parsed;
      try { parsed = parseStatement(await file.text()); }
      catch (err) { throw new Error(`${file.name}: ${err.message}`); }
      const r = mergeTransactions(state.raw, withIds(parsed.transactions));
      state.raw = r.merged; added += r.addedCount; skipped += r.skippedCount;
    }
    $('status').textContent = `Added ${plural(added, 'transaction', 'transactions')}` +
      (skipped ? ` and skipped ${skipped} you already had` : '') + '. Nothing was uploaded.';
  } catch (err) {
    $('status').textContent = err.message;
  }
  resetGl();
  recompute();
  render();
  if (added) markDirty();
}
$('file').addEventListener('change', e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) importFiles(files);
});

// ---------- saving ----------
const snapshot = () => ({ version: 1, raw: state.raw, overrides: state.overrides, trips: state.trips, plan, coding: state.coding, names: state.names, customs: state.customs, removed: state.removed, opening: state.opening });

function loadSnapshot(d) {
  state.raw = Array.isArray(d.raw) ? d.raw : [];
  state.overrides = d.overrides && typeof d.overrides === 'object' ? d.overrides : {};
  state.trips = Array.isArray(d.trips) ? d.trips : [];
  state.customs = cleanCustoms(d.customs);
  applyCustoms(state.customs);
  state.names = cleanNames(d.names);
  state.removed = cleanRemoved(d.removed);
  applyRemoved(state.removed);
  state.coding = cleanCoding(d.coding);
  state.opening = cleanOpening(d.opening);
  try { validatePlan(d.plan); plan = d.plan; } catch { plan = samplePlan; }
}

function clearMemory() {
  state.raw = []; state.overrides = {}; state.trips = []; state.coding = {}; state.names = {}; state.customs = []; state.removed = {}; applyRemoved({}); state.opening = { date: DEFAULT_OPENING_DATE, balances: {} }; state.txs = [];
  state.ym = null; state.year = null; resetGl();
  plan = samplePlan;
}

let saveTimer = null;
let saveChain = Promise.resolve();
function markDirty() {
  if (state.vault && !state.demo) { state.save = 'pending'; clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 300); }
  renderSaveState();
}
function flushSave() {
  clearTimeout(saveTimer);
  if (!state.vault || state.demo || state.save !== 'pending') return saveChain;   // nothing changed, nothing to write
  saveChain = saveChain.then(async () => {
    try { await storage.save(await seal(state.vault, snapshot())); state.save = 'saved'; }
    catch { state.save = 'error'; }
    renderSaveState();
  });
  return saveChain;
}
// Switching apps on an iPad can freeze the page, so save the moment it is hidden.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && state.save === 'pending') flushSave(); });

function renderSaveState() {
  let text = '';
  if (state.demo) text = PREVIEW ? 'Preview · dummy numbers on' : 'Dummy numbers on';
  else if (PREVIEW) text = 'Preview: nothing is saved';
  else if (state.locked) text = 'Locked';
  else if (state.vault) text = { pending: 'Saving…', saved: 'Saved on this device', idle: 'Saved on this device', error: "Couldn't save. Download a backup." }[state.save];
  else if (state.raw.length) text = 'Not saved yet';
  const chip = $('savechip');
  chip.textContent = text;
  chip.hidden = !text;
  chip.className = 'savechip' + (state.demo ? ' demo' : state.save === 'error' || (!PREVIEW && !state.vault && state.raw.length) ? ' warn' : '');
  $('savebanner').hidden = PREVIEW || state.demo || !!state.vault || state.locked || !state.raw.length;
}

// ---------- passphrase, lock, backup ----------
const STORAGE_MSG = "This browser can't save data here (private browsing?).";

async function setPassphrase(pass, again) {
  if (pass.length < 8) throw new Error('Use at least 8 characters. A few random words work well.');
  if (pass !== again) throw new Error("The two passphrases don't match.");
  const vault = await createVault(pass);
  try { await storage.save(await seal(vault, snapshot())); } catch { throw new Error(STORAGE_MSG); }
  state.vault = vault; state.save = 'saved'; state.envelope = null;
  state.persisted = await storage.requestPersistence();
}

async function lockNow() {
  await flushSave();
  try { state.envelope = await storage.load(); } catch { state.envelope = null; }
  state.vault = null; state.locked = true;
  clearMemory();
  render();
}

async function doUnlock() {
  const msg = $('lock-msg');
  msg.className = 'msg'; msg.textContent = 'Unlocking…';
  try {
    const { vault, data } = await unlock(state.envelope, $('lock-pass').value);
    if (state.demo) {
      // Dummy numbers were on: the passphrase is still required to get in, but the real data stays locked away.
      loadSnapshot(dummySnapshot());
      state.vault = null; state.locked = false; state.save = 'idle'; state.tab = 'budget';
      $('status').textContent = 'Showing dummy numbers. Your own data is not on screen.';
    } else {
      loadSnapshot(data);
      state.vault = vault; state.locked = false; state.save = 'saved'; state.tab = 'budget';
    }
    $('lock-pass').value = ''; msg.textContent = '';
    recompute(); render();
  } catch (err) {
    msg.className = 'msg error'; msg.textContent = err.message;
  }
}
$('lock-form').addEventListener('submit', e => { e.preventDefault(); doUnlock(); });

async function restoreFrom(file, pass) {
  if (!file) throw new Error('Choose the backup file first.');
  let env;
  try { env = JSON.parse(await file.text()); } catch { throw new Error('That file is not a My Budget backup.'); }
  const { vault, data } = await unlock(env, pass);
  loadSnapshot(data);
  try { await storage.save(await seal(vault, snapshot())); } catch { throw new Error(STORAGE_MSG); }
  state.vault = vault; state.locked = false; state.envelope = null; state.save = 'saved';
  state.persisted = await storage.requestPersistence();
  recompute(); render(); renderSettingsScreen();
}

async function eraseDevice() {
  await storage.clear();
  state.vault = null; state.locked = false; state.envelope = null; state.save = 'idle';
  clearMemory(); recompute(); render(); renderSettingsScreen();
  $('status').textContent = 'Everything on this device was erased.';
}

async function downloadBackup() {
  if (!state.vault) throw new Error('Set a passphrase first. The backup is encrypted with it.');
  const env = await seal(state.vault, snapshot());
  const url = URL.createObjectURL(new Blob([JSON.stringify(env)], { type: 'application/json' }));
  const a = h('a', { href: url, download: `my-budget-backup-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// A destructive button asks twice: the first tap changes its label, the second does it.
function twoStep(label, confirmLabel, action, cls = 'btn ghost danger') {
  let armed = false, timer;
  const b = h('button', { type: 'button', class: cls, text: label, onclick: async () => {
    if (!armed) { armed = true; b.textContent = confirmLabel; timer = setTimeout(() => { armed = false; b.textContent = label; }, 5000); return; }
    clearTimeout(timer); armed = false; b.textContent = label;
    await action();
  } });
  return b;
}

// ---------- GL detail ----------
// The full ledger. Tapping a number or bar anywhere else opens this tab, narrowed to what you tapped,
// with a Back button to return.
const emptyGl = () => ({ cat: '', ym: '', q: '', week: '', ask: false, acct: '', from: '', to: '' });
const resetGl = () => { state.gl = emptyGl(); };

function drill(filter) {
  const gl = emptyGl();
  if (filter.type === 'category') { gl.cat = filter.id; gl.ym = filter.ym ?? ''; gl.from = filter.from ?? ''; gl.to = filter.to ?? ''; }
  else if (filter.type === 'source') { gl.acct = filter.account; gl.ym = filter.ym ?? ''; }
  else if (filter.type === 'week') gl.week = filter.start;
  else if (filter.type === 'ask') gl.ask = true;
  state.gl = gl;
  if (!(state.tab === 'fs' && state.fsPage === 'gl')) state.returnTo = { tab: state.tab, page: state.fsPage };
  state.tab = 'fs'; state.fsPage = 'gl';
  applyTab();
  renderLedger();
  window.scrollTo({ top: 0 });
}

const glActive = () => { const g = state.gl; return !!(g.cat || g.acct || g.ym || g.from || g.to || g.q.trim() || g.week || g.ask); };

function visibleTxs() {
  const g = state.gl;
  let list = state.txs;
  if (g.cat) list = list.filter(t => t.category === g.cat);
  if (g.from) list = list.filter(t => t.date >= g.from);
  if (g.to) list = list.filter(t => t.date <= g.to);
  if (g.acct) list = list.filter(t => t.account === g.acct);
  if (g.ym) list = list.filter(t => monthOf(t.date) === g.ym);
  if (g.week) list = list.filter(t => t.date >= g.week && t.date <= addDays(g.week, 6));
  if (g.ask) list = list.filter(t => t.askReimbursement);
  const q = g.q.trim().toLowerCase();
  if (q) list = list.filter(t => t.description.toLowerCase().includes(q));
  return [...list].reverse();
}

// Swaps a row's category label for a picker. Your choice is remembered and beats the automatic one.
function openPicker(cell, t) {
  const groups = new Map();
  for (const c of selectableCategories(state.trips)) {
    if (!groups.has(c.class)) groups.set(c.class, []);
    groups.get(c.class).push(c);
  }
  const select = h('select', { 'aria-label': `Category for ${t.description}`,
    onchange: e => {
      if (e.target.value === '__auto') delete state.overrides[t.id]; else state.overrides[t.id] = e.target.value;
      recompute(); render(); markDirty();
    },
    onblur: () => renderGlRows() },
    h('option', { value: '__auto', text: 'Let the app decide' }),
    [...groups].map(([cls, items]) => h('optgroup', { label: cls }, items.map(c => h('option', { value: c.id, text: c.label, selected: c.id === t.category })))));
  cell.replaceChildren(select);
  select.focus();
}

function renderGlControls() {
  const months = [...new Set(state.txs.map(t => monthOf(t.date)))].sort().reverse();
  const cats = [...new Set([...state.txs.map(t => t.category), state.gl.cat].filter(Boolean))]
    .sort((a, b) => (CATEGORIES[a].code ?? '9999').localeCompare(CATEGORIES[b].code ?? '9999'));
  fill($('gl-controls'),
    h('input', { type: 'search', id: 'gl-q', placeholder: 'Search descriptions', 'aria-label': 'Search descriptions', value: state.gl.q,
      oninput: e => { state.gl.q = e.target.value; renderGlRows(); } }),
    h('select', { id: 'gl-month', 'aria-label': 'Month', onchange: e => { state.gl.ym = e.target.value; renderGlRows(); } },
      h('option', { value: '', text: 'All months' }), months.map(ym => h('option', { value: ym, text: fmtMonth(ym), selected: ym === state.gl.ym }))),
    h('select', { id: 'gl-cat', 'aria-label': 'GL account', onchange: e => { state.gl.cat = e.target.value; renderGlRows(); } },
      h('option', { value: '', text: 'All accounts' }), cats.map(id => h('option', { value: id, text: codeLabel(id), selected: id === state.gl.cat }))));
}

function renderGlRows() {
  const list = visibleTxs();
  $('gl-count').textContent = glActive()
    ? `${list.length} of ${plural(state.txs.length, 'transaction', 'transactions')}`
    : plural(state.txs.length, 'transaction', 'transactions');
  const chip = (label, onclear) => h('span', { class: 'chip' }, label,
    h('button', { type: 'button', 'aria-label': `Remove filter: ${label}`, text: '×', onclick: onclear }));
  fill($('chips'),
    (state.gl.from && state.gl.to) && chip(`${fmtDate(state.gl.from)} to ${fmtDate(state.gl.to)}`, () => { state.gl.from = ''; state.gl.to = ''; renderGlRows(); }),
    state.gl.acct && chip(`Account: ${sourceLabel(state.gl.acct)}`, () => { state.gl.acct = ''; renderGlRows(); }),
    state.gl.week && chip(`Week of ${fmtDate(state.gl.week)}`, () => { state.gl.week = ''; renderGlRows(); }),
    state.gl.ask && chip('Big dinners and drinks to ask about', () => { state.gl.ask = false; renderGlRows(); }),
    glActive() && h('button', { type: 'button', class: 'linkbtn', text: 'Clear all filters', onclick: () => { resetGl(); renderGlControls(); renderGlRows(); } }));
  const back = $('gl-back');
  back.hidden = !state.returnTo;
  if (state.returnTo) back.textContent = `← Back to ${state.returnTo.tab === 'fs' ? FS_PAGES.find(p => p[0] === state.returnTo.page)[1] : TAB_LABELS[state.returnTo.tab]}`;

  const body = $('out').querySelector('tbody');
  body.replaceChildren();
  for (const t of list) {
    const notes = [t.transfer === 'unmatched' && t.category === 'review' && 'other side not imported', t.transfer === 'suggested' && 'possible transfer', t.askReimbursement && 'paid back?', t.chosen && 'your choice', t.byHand && 'entered by hand'].filter(Boolean);
    const tr = body.insertRow();
    tr.insertCell().textContent = fmtDate(t.date);
    tr.insertCell().textContent = t.description;
    tr.insertCell().textContent = sourceLabel(t.account);
    const cat = tr.insertCell();
    cat.append(h('span', { text: codeLabel(t.category) }),
      h('button', { type: 'button', class: 'linkbtn', text: 'Change', 'aria-label': `Change category for ${t.description}`, onclick: () => openPicker(cat, t) }));
    if (notes.length) cat.append(h('div', { class: 'flag', text: notes.join(' · ') }));
    if (t.byHand) cat.append(h('button', { type: 'button', class: 'linkbtn', text: 'Remove', 'aria-label': `Remove ${t.description}`, onclick: () => { state.raw = state.raw.filter(r => r.id !== t.id); delete state.overrides[t.id]; recompute(); render(); markDirty(); } }));
    const amt = tr.insertCell(); amt.className = 'num'; amt.textContent = money2(t.cents);
  }
  fill($('coverage'), coverage(state.txs).map(c =>
    h('div', { text: `${sourceLabel(c.account)}: ${fmtDate(c.from)} to ${fmtDate(c.to)} (${plural(c.count, 'transaction', 'transactions')})` })));
}

function renderLedger() { renderGlControls(); renderGlRows(); }

// ---------- Budget tab: looking back ----------
// Backward-looking on purpose: you add statements in batches, so "this week" is rarely a full week. Everything
// here is built from full Sunday-to-Saturday weeks, over a period you choose.
const PERIODS = [['4w', '4 wks', 'Last 4 weeks'], ['8w', '8 wks', 'Last 8 weeks'], ['12w', '12 wks', 'Last 12 weeks'], ['ytd', 'YTD', 'Year to date']];
const periodLabel = k => PERIODS.find(p => p[0] === k)[2];
const rangeText = (from, to) => `${fmtDate(from)} to ${fmtDate(to)}`;

function budgetData() {
  const all = weeklyRunning(state.txs, plan);
  const complete = completeWeeks(all);
  const { rows, prev } = periodWindow(complete, state.period);
  const totals = periodTotals(rows);
  const prevTotals = prev.length ? periodTotals(prev) : null;
  return { all, complete, rows, prev, totals, prevTotals, compare: compareTotals(totals, prevTotals) };
}

function renderBudget(asOf, keepFocus) {
  const d = budgetData();
  renderBudgetSummary(d, asOf);
  renderWeeks(d);
  renderSavingsImpact(d);
  renderWhere(d);
  renderHabits(d);
  renderMonth(asOf, keepFocus);
}

function meter(spent, target, label) {
  const over = spent > target;
  const pct = target > 0 ? Math.min(100, Math.max(0, spent / target * 100)) : 100;
  return h('div', { class: 'meter' + (over ? ' over' : ''), role: 'img', 'aria-label': label },
    h('div', { class: 'fill', style: `width:${pct}%` }));
}

function renderBudgetSummary(d, asOf) {
  const t = d.totals;
  const toggle = h('select', { id: 'bgt-period', 'aria-label': 'Time period', onchange: e => { state.period = e.target.value; renderBudget(asOf, false); } },
    PERIODS.map(([k, , long]) => h('option', { value: k, text: long, selected: state.period === k })));

  // a week still in progress, after the last full one, is left out of the numbers but not hidden
  const lastFull = d.complete[d.complete.length - 1];
  const tail = [...d.all].reverse().find(r => r.partial && (!lastFull || r.weekStart > lastFull.weekStart));
  const stale = staleAccounts(state.txs);
  const notes = [
    tail && `Not counted: ${rangeText(tail.weekStart, asOf)}, a week still in progress (${money(tail.spent)} of free cash spent so far).`,
    stale.length && `${stale.map(a => SOURCE_ACCOUNTS[a.account]?.name ?? a.account).join(' and ')} ${stale.length === 1 ? 'data ends' : 'data end'} ${fmtDate(stale[0].to)}, a few days before the rest, so the latest week can look lighter than it was.`,
  ].filter(Boolean).map(text => h('p', { class: 'note', text }));

  if (!t.weeks) {
    fill($('bgt-summary'),
      h('div', { class: 'card-head' }, h('h2', { id: 'bgt-title', text: 'How you did' }), toggle),
      h('p', { text: 'No full week to look back on yet. A week runs Sunday to Saturday, and your first one hasn’t finished.' }),
      notes);
    return;
  }
  const c = d.compare;
  const vsBefore = !c ? null
    : c.spentDelta === 0 ? `Spending is the same as the ${plural(t.weeks, 'week', 'weeks')} before.`
    : `Compared with the ${plural(t.weeks, 'week', 'weeks')} before, spending is ${c.spentDelta < 0 ? 'down' : 'up'} ${money(c.spentDelta)}${c.pct == null ? '' : ` (${Math.abs(Math.round(c.pct * 100))}%)`}.`;

  fill($('bgt-summary'),
    h('div', { class: 'card-head' }, h('h2', { id: 'bgt-title', text: periodLabel(state.period) }), toggle),
    h('p', { class: 'sub', text: `${rangeText(t.from, t.to)} · ${plural(t.weeks, 'full week', 'full weeks')}` }),
    h('div', { class: 'hero-num' }, signed(t.effect), h('small', { text: t.effect >= 0 ? 'added to savings' : 'pulled from savings' })),
    meter(t.spent, t.target, `Spent ${money(t.spent)} of ${money(t.target)}`),
    h('div', { class: 'legend-row' },
      h('span', { text: `Spent ${money(t.spent)} of ${money(t.target)} in free cash` }),
      h('button', { type: 'button', class: 'linkbtn', id: 'edit-plan', style: 'padding:0', text: 'Edit plan', onclick: openPlan })),
    h('p', { text: `${t.under} of ${plural(t.weeks, 'week', 'weeks')} came in under target. An average week was ${money(t.avgSpent)}, against a ${money(t.avgTarget)} target.` }),
    vsBefore && h('p', { text: vsBefore }),
    notes);
}

// ----- charts -----
function barPath(x, y0, y1, w, r) {
  const rad = Math.min(r, Math.abs(y1 - y0), w / 2);
  const up = y1 < y0;
  return up
    ? `M${x},${y0} V${y1 + rad} Q${x},${y1} ${x + rad},${y1} H${x + w - rad} Q${x + w},${y1} ${x + w},${y1 + rad} V${y0} Z`
    : `M${x},${y0} V${y1 - rad} Q${x},${y1} ${x + rad},${y1} H${x + w - rad} Q${x + w},${y1} ${x + w},${y1 - rad} V${y0} Z`;
}

// One tooltip per chart. It follows hover and keyboard focus and is never the only way to see a number.
function chartTip(wrap) {
  const tip = h('div', { class: 'tip', hidden: true, role: 'presentation' });
  return {
    tip,
    hide: () => { tip.hidden = true; },
    show(anchor, lines) {
      const r = anchor.getBoundingClientRect(), box = wrap.getBoundingClientRect();
      fill(tip, h('b', { text: lines[0] }), ...lines.slice(1).flatMap(l => [h('br'), h('span', { text: l })]));
      tip.hidden = false;
      tip.style.left = `${Math.min(Math.max(r.left + r.width / 2 - box.left, 90), box.width - 90)}px`;
      tip.style.top = `${r.top - box.top - 8}px`;
    },
  };
}
const chartWidth = id => { const w = $(id).clientWidth - 38; return w > 200 ? Math.round(w) : 640; };   // card width less its padding and border

function weeksChart(rows) {
  const W = chartWidth('bgt-weeks'), H = 230, padL = 8, padR = 8, padT = 28, padB = 30;
  const maxV = Math.max(...rows.map(r => Math.max(r.spent, r.target))) * 1.1 || 1;
  const y = v => padT + (1 - v / maxV) * (H - padT - padB);
  const slot = (W - padL - padR) / rows.length, bw = Math.min(24, slot * 0.6);
  let lo = 0, hi = 0;
  rows.forEach((r, i) => { if (r.spent < rows[lo].spent) lo = i; if (r.spent > rows[hi].spent) hi = i; });
  const labelAll = rows.length <= 8, everyOther = rows.length > 8;

  const wrap = h('div', { class: 'chart-wrap' });
  const { tip, show, hide } = chartTip(wrap);
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Free-cash spending by week, against the weekly target' });
  svg.append(s('line', { class: 'zero', x1: padL, x2: W - padR, y1: y(0), y2: y(0) }));

  rows.forEach((r, i) => {
    const cx = padL + slot * i + slot / 2, over = r.spent > r.target;
    const open = () => drill({ type: 'week', start: r.weekStart });
    const bar = s('path', { class: 'bar' + (over ? ' neg' : ''), d: barPath(cx - bw / 2, y(0), y(r.spent), bw, 4) });
    const g = s('g', {
      class: 'hit', tabindex: 0, role: 'button',
      'aria-label': `Week of ${fmtDate(r.weekStart)}: spent ${money(r.spent)} against a ${money(r.target)} target, ${over ? 'over' : 'under'}. Show these transactions.`,
      onpointerenter: () => show(bar, [`${money(r.spent)} spent`, `Week of ${fmtDate(r.weekStart)}`, `Target ${money(r.target)} (${signed(r.effect)})`]),
      onfocus: () => show(bar, [`${money(r.spent)} spent`, `Week of ${fmtDate(r.weekStart)}`, `Target ${money(r.target)} (${signed(r.effect)})`]),
      onpointerleave: hide, onblur: hide, onclick: open,
      onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } },
    },
      s('rect', { x: cx - slot / 2, y: 0, width: slot, height: H - padB + 16, fill: 'transparent' }),
      bar,
      s('line', { class: 'tline', x1: cx - slot * 0.42, x2: cx + slot * 0.42, y1: y(r.target), y2: y(r.target) }),
      s('rect', { class: 'focus-ring', x: cx - slot / 2 + 1, y: 1, width: slot - 2, height: H - padB + 14, rx: 6 }));
    svg.append(g);
    if (labelAll || i === lo || i === hi) {
      // the label sits just above its own bar, unless the target line is right there, then it goes above the line
      let labelY = y(r.spent) - 7;
      if (y(r.target) < y(r.spent) && y(r.target) > labelY - 12) labelY = y(r.target) - 7;
      svg.append(s('text', { class: 'val', x: cx, y: labelY, 'text-anchor': 'middle', text: money(r.spent) }));
    }
    if (!everyOther || i % 2 === rows.length % 2 || i === rows.length - 1) {
      svg.append(s('text', { x: cx, y: H - 8, 'text-anchor': 'middle', text: fmtDate(r.weekStart) }));
    }
  });
  wrap.append(svg, tip);
  return wrap;
}

function renderWeeks(d) {
  const rows = d.rows;
  if (!rows.length) {
    fill($('bgt-weeks'), h('h2', { id: 'bgt-weeks-title', text: 'Week by week' }),
      h('p', { class: 'sub', text: 'Once you have a full week (Sunday to Saturday), your weeks line up against each other here.' }));
    return;
  }
  const lowest = rows.reduce((a, r) => (r.spent < a.spent ? r : a)), highest = rows.reduce((a, r) => (r.spent > a.spent ? r : a));
  const table = h('table', { class: 'tie' },
    h('thead', {}, h('tr', {}, h('th', { text: 'Week of' }), h('th', { class: 'num', text: 'Spent' }), h('th', { class: 'num', text: 'Target' }), h('th', { class: 'num', text: '+/−' }))),
    h('tbody', {}, [...rows].reverse().map(r => h('tr', {},
      h('td', { text: fmtDate(r.weekStart) }), h('td', { class: 'num', text: money(r.spent) }),
      h('td', { class: 'num', text: money(r.target) }), h('td', { class: 'num', text: swing(r.effect) })))));
  fill($('bgt-weeks'),
    h('div', { class: 'card-head' }, h('h2', { id: 'bgt-weeks-title', text: 'Week by week' }), h('span', { class: 'sub', text: 'Sunday to Saturday' })),
    weeksChart(rows),
    h('div', { class: 'legend-row' },
      h('span', { class: 'key' }, h('i'), 'Within target'),
      h('span', { class: 'key' }, h('i', { class: 'red' }), 'Over target'),
      h('span', { class: 'key' }, h('i', { class: 'dash' }), 'Weekly target')),
    rows.length > 1 && h('p', { class: 'sub', text: `Lightest week: ${fmtDate(lowest.weekStart)}, ${money(lowest.spent)}. Heaviest: ${fmtDate(highest.weekStart)}, ${money(highest.spent)}.` }),
    h('details', { class: 'fine' }, h('summary', { text: 'Show the numbers' }), h('div', { class: 'scroll' }, table)));
}

function savingsChart(series) {
  const W = chartWidth('bgt-savings'), H = 200, padL = 8, padR = 12, padT = 30, padB = 30;
  const vals = series.map(p => p.running);
  const max = Math.max(0, ...vals), min = Math.min(0, ...vals), span = max - min || 1;
  const y = v => padT + (max - v) / span * (H - padT - padB);
  const n = series.length, x = i => padL + (n === 1 ? (W - padL - padR) / 2 : i * (W - padL - padR) / (n - 1));

  const wrap = h('div', { class: 'chart-wrap' });
  const { tip, show, hide } = chartTip(wrap);
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Running effect on savings, week by week' });
  svg.append(s('line', { class: 'zero', x1: padL, x2: W - padR, y1: y(0), y2: y(0) }),
    s('path', { class: 'line', d: series.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.running)}`).join(' ') }));

  const last = series[n - 1];
  const dot = s('circle', { class: 'dot', cx: x(n - 1), cy: y(last.running), r: 4.5 });
  svg.append(s('circle', { class: 'dot-ring', cx: x(n - 1), cy: y(last.running), r: 6.5 }), dot);
  svg.append(s('text', { class: 'val', x: x(n - 1), y: y(last.running) + (last.running >= 0 ? -12 : 20), 'text-anchor': 'end', text: signed(last.running) }));

  const marker = s('circle', { class: 'dot', cx: 0, cy: 0, r: 5, style: 'display:none' });
  const markerRing = s('circle', { class: 'dot-ring', cx: 0, cy: 0, r: 7, style: 'display:none' });
  svg.append(markerRing, marker);
  const place = (i, on) => { for (const m of [marker, markerRing]) { m.style.display = on ? '' : 'none'; m.setAttribute('cx', x(i)); m.setAttribute('cy', y(series[i].running)); } };
  const lines = p => [`${signed(p.running)} running total`, `Week of ${fmtDate(p.weekStart)}`, `That week: ${signed(p.effect)}`];
  const step = n > 6 ? Math.ceil(n / 5) : 1;
  series.forEach((p, i) => {
    const slotW = n === 1 ? W : (W - padL - padR) / (n - 1);
    const open = () => drill({ type: 'week', start: p.weekStart });
    svg.append(s('rect', {
      class: 'hit-col', tabindex: 0, role: 'button', x: x(i) - slotW / 2, y: 0, width: slotW, height: H - padB + 12, fill: 'transparent',
      'aria-label': `Week of ${fmtDate(p.weekStart)}: running total ${signed(p.running)}. Show that week's transactions.`,
      onpointerenter: () => { place(i, true); show(marker, lines(p)); }, onfocus: () => { place(i, true); show(marker, lines(p)); },
      onpointerleave: () => { place(i, false); hide(); }, onblur: () => { place(i, false); hide(); },
      onclick: open, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } },
    }));
    if (i % step === 0 || i === n - 1) svg.append(s('text', { x: x(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle', text: fmtDate(p.weekStart) }));
  });
  wrap.append(svg, tip);
  return wrap;
}

function renderSavingsImpact(d) {
  const series = cumulativeSeries(d.complete);
  if (series.length < 2) {
    fill($('bgt-savings'), h('h2', { id: 'bgt-savings-title', text: 'Effect on your savings' }),
      h('p', { class: 'sub', text: 'This needs at least two full weeks. It adds up every week’s result into one running total.' }));
    return;
  }
  const total = series[series.length - 1].running;
  const t = d.totals;
  fill($('bgt-savings'),
    h('div', { class: 'card-head' }, h('h2', { id: 'bgt-savings-title', text: 'Effect on your savings' }), h('span', { class: 'sub', text: `since ${fmtDate(series[0].weekStart)}` })),
    h('div', { style: 'font-size:32px;font-weight:700;letter-spacing:-0.02em', text: signed(total) }),
    h('p', { class: 'sub', text: `${total >= 0 ? 'Your spending has added' : 'Your spending has pulled'} ${money(total)} ${total >= 0 ? 'to' : 'from'} savings across ${plural(series.length, 'full week', 'full weeks')}.${t.weeks ? ` The ${periodLabel(state.period).toLowerCase()} account for ${signed(t.effect)} of that.` : ''}` }),
    savingsChart(series.slice(-26)),
    h('p', { class: 'note', text: 'Each point is the running total at the end of a week. Above the line you have added to savings, below it you have pulled from savings.' }));
}

// ----- where it went, and habits, over the same period -----
function renderWhere(d) {
  const t = d.totals;
  if (!t.weeks) {
    fill($('where'), h('h2', { id: 'where-title', text: 'Where the free cash went' }), h('p', { class: 'sub', text: 'Nothing to show until there is a full week.' }));
    return;
  }
  const b = categoryBreakdownRange(state.txs, t.from, t.to);
  const before = d.prevTotals ? categoryBreakdownRange(state.txs, d.prevTotals.from, d.prevTotals.to) : null;
  const beforeBy = new Map((before?.rows ?? []).map(r => [r.id, r.cents]));
  const top = b.rows[0]?.cents ?? 1;
  fill($('where'),
    h('div', { class: 'card-head' },
      h('h2', { id: 'where-title', text: 'Where the free cash went' }),
      h('span', { class: 'sub', text: `${periodLabel(state.period)} · ${money(b.total)}` })),
    b.rows.length
      ? h('div', { class: 'cats' }, b.rows.map(r => {
          const delta = before ? r.cents - (beforeBy.get(r.id) ?? 0) : null;
          return h('button', { type: 'button', class: 'catrow', 'aria-label': `${r.name}: ${money(r.cents)}${delta ? `, ${signed(delta)} compared with the weeks before` : ''}. Show these transactions.`,
            onclick: () => drill({ type: 'category', id: r.id, from: t.from, to: t.to }) },
            h('span', { class: 'catname', text: r.name }),
            h('span', { class: 'cattrack' },
              h('span', { class: 'catbar' + (r.id === 'review' ? ' review' : ''), style: `width:${Math.max(1, r.cents / top * 56)}%` }),
              h('span', { class: 'catval', text: `${money(r.cents)} · ${Math.round(r.share * 100)}%` }),
              delta ? h('span', { class: 'catdelta', text: signed(delta) }) : null));
        }))
      : h('p', { class: 'sub', text: 'No free-cash spending in this period.' }),
    b.rows.length && h('p', { class: 'note', text: `Tap a row to see the transactions behind it.${before ? ' The small number is the change from the weeks before.' : ''}` }));
}

function renderHabits(d) {
  const t = d.totals;
  const hb = habits(d.rows);
  const streak = habits(d.complete).streak;
  const dining = t.weeks ? diningOutRange(state.txs, t.from, t.to) : { cents: 0, share: 0 };
  const biggest = t.weeks ? topPurchasesRange(state.txs, t.from, t.to, 1)[0] : null;
  const att = attention(state.txs);
  const c = d.compare;
  const link = (label, filter) => h('button', { type: 'button', text: label, onclick: () => drill(filter) });

  const good = [], watch = [];
  if (hb.under > 0) good.push(h('li', { text: `${hb.under} of ${plural(hb.weeks, 'week', 'weeks')} came in under target.` }));
  if (streak >= 2) good.push(h('li', { text: `${streak} weeks in a row under target, counting back from the latest full week.` }));
  if (hb.best && hb.best.effect > 0) good.push(h('li', {}, `Best week: ${fmtDate(hb.best.weekStart)}, ${money(hb.best.effect)} added to savings.`, link('See it', { type: 'week', start: hb.best.weekStart })));
  if (c && c.spentDelta < 0) good.push(h('li', { text: `Spending is down ${money(c.spentDelta)} from the ${plural(t.weeks, 'week', 'weeks')} before.` }));
  if (hb.over > 0) watch.push(h('li', { text: `${hb.over} of ${plural(hb.weeks, 'week', 'weeks')} ran over target.` }));
  if (hb.worst && hb.worst.effect < 0) watch.push(h('li', {}, `Roughest week: ${fmtDate(hb.worst.weekStart)}, ${money(hb.worst.effect)} pulled from savings.`, link('See it', { type: 'week', start: hb.worst.weekStart })));
  if (c && c.spentDelta > 0 && (c.pct ?? 0) >= 0.1) watch.push(h('li', { text: `Spending is up ${money(c.spentDelta)} (${Math.round(c.pct * 100)}%) from the ${plural(t.weeks, 'week', 'weeks')} before.` }));
  if (dining.cents > 0 && dining.share >= 0.35) watch.push(h('li', { text: `Restaurants, coffee and bars are ${Math.round(dining.share * 100)}% of free spending (${money(dining.cents)}).` }));
  if (biggest) watch.push(h('li', { text: `Biggest purchase: ${money(biggest.cents)} at ${biggest.description}.` }));
  if (att.review.count) watch.push(h('li', {}, `${plural(att.review.count, 'charge', 'charges')} (${money(att.review.cents)}) still need a category. They count against free cash until then.`, link('Review', { type: 'category', id: 'review' })));
  if (att.reimbursements.length) watch.push(h('li', {}, `Expecting to be paid back for ${plural(att.reimbursements.length, 'big dinner or drinks charge', 'big dinner or drinks charges')}?`, link('See them', { type: 'ask' })));

  const card = (cls, title, items) => h('div', { class: `habit-card ${cls}` },
    h('h2', { text: title }),
    items.length ? h('ul', {}, items) : h('p', { class: 'none', text: 'Nothing here yet.' }));
  fill($('habits'), card('good', 'Going well', good), card('watch', 'Worth a look', watch));
}

// ----- one month, start to finish -----
function renderMonth(asOf, keepFocus) {
  const months = [...new Set(state.txs.map(t => monthOf(t.date)))].sort().reverse();
  const p = monthPace(state.txs, plan, state.ym, asOf);
  const m = monthSummary(state.txs, plan, state.ym);
  const over = p.left < 0;
  const select = h('select', { id: 'month', 'aria-label': 'Month', onchange: e => { state.ym = e.target.value; renderMonth(asOf, true); } },
    months.map(ym => h('option', { value: ym, text: fmtMonth(ym), selected: ym === state.ym })));
  const row = (label, g) => [h('span', { text: label }), h('span', { text: `${money(g.actual)} of ${money(g.planned)}` })];
  fill($('monthcard'),
    h('div', { class: 'card-head' }, h('h2', { id: 'month-title', text: 'Month in review' }), select),
    h('div', { style: 'font-size:28px;font-weight:700;letter-spacing:-0.02em' }, money(Math.abs(p.left)),
      h('small', { style: 'font-size:16px;font-weight:600;color:var(--ink-2);margin-left:6px', text: over ? 'over free cash' : 'under free cash' })),
    meter(p.spent, p.free, `Spent ${money(p.spent)} of ${money(p.free)}`),
    h('p', { class: 'sub', text: p.complete
      ? `Spent ${money(p.spent)} of ${money(p.free)} free cash. The month finished ${money(Math.abs(p.left))} ${over ? 'over' : 'under'}.`
      : `Month still in progress: ${money(p.spent)} spent so far, out of ${money(p.free)} for the whole month.` }),
    h('div', { class: 'plan-rows' },
      row('Paycheck', m.income), row('Fixed bills', m.fixed), row('Subscriptions', m.subscriptions),
      row('One-time & annual set-aside', m.onetime),
      (m.vacation.planned > 0 || m.vacation.actual > 0) && row('Vacation set-aside', m.vacation),
      row('Savings moved', m.savings)));
  if (keepFocus) $('month').focus();
}

// ---------- trial balance and income statement (TB Summary tab) ----------
const TB_VIEWS = [['bal', 'Month-end balances'], ['act', 'Monthly activity']];
const viewToggle = asOf => h('select', { id: 'tb-view', 'aria-label': 'View', onchange: e => { state.tbView = e.target.value; renderTrialBalance(asOf); } },
  TB_VIEWS.map(([id, label]) => h('option', { value: id, text: label, selected: state.tbView === id })));

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const yearsOf = () => [...new Set(state.txs.map(t => t.date.slice(0, 4)))].sort().reverse();
// The month picked for the Income Statement and Balance Sheet: '' means the full year.
function pickedMonth() {
  const ok = state.month && state.month.startsWith(state.year + '-') && state.txs.some(t => t.date.startsWith(state.month));
  return ok ? state.month : '';
}
// Year and month dropdowns shared by the two statements.
function periodPickers(asOf, id) {
  const yms = [...new Set(state.txs.filter(t => t.date.startsWith(state.year + '-')).map(t => t.date.slice(0, 7)))].sort();
  const mo = pickedMonth();
  const year = h('select', { id: `year-${id}`, 'aria-label': 'Year', onchange: e => { state.year = e.target.value; renderFS(asOf, `year-${id}`); } },
    yearsOf().map(y => h('option', { value: y, text: y, selected: y === state.year })));
  const month = h('select', { id: `month-${id}`, 'aria-label': 'Month', onchange: e => { state.month = e.target.value; renderFS(asOf, `month-${id}`); } },
    h('option', { value: '', text: 'Full year', selected: !mo }),
    yms.map(ym => h('option', { value: ym, text: MONTH_NAMES[Number(ym.slice(5)) - 1], selected: ym === mo })));
  return h('div', { class: 'row-form' }, month, year);
}

// The three statement pages are drawn together, so a change of year shows on all of them.
function renderFS(asOf, focusId) {
  renderTrialBalance(asOf);
  renderBalanceSheet(asOf);
  renderMatrix(asOf);
  if (focusId) $(focusId)?.focus();
}

// Where a trial-balance number leads in GL Detail.
function drillFor(row, ym) {
  if (row.key === 'clearing' || row.key === 'equity' || row.key === 'retained') return null;
  if (row.key.startsWith('src:')) return { type: 'source', account: row.key.slice(4), ym };
  return { type: 'category', id: row.key, ym };
}

const fmtFull = iso => dateOf(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function renderTrialBalance(asOf) {
  const bal = state.tbView === 'bal';
  const years = yearsOf();
  const tb = trialBalance(state.txs, state.year, asOf, state.opening);
  const shown = bal ? tb.rows : tb.rows.filter(r => tb.months.some(ym => r.byMonth[ym] !== 0));
  const shownMonth = ym => (bal ? tb.reached[ym] : tb.hasData[ym]);
  const cellValue = (r, ym) => (bal ? r.balByMonth[ym] : r.byMonth[ym]);

  const head = h('tr', {}, h('th', { class: 'acct', style: 'text-align:left', text: 'GL account' }),
    bal && h('th', {}, 'Opening', h('small', { text: fmtFull(tb.openDate) })),
    tb.months.map((ym, i) => h('th', {}, MONTH_ABBR[i], ym === tb.partialMonth && h('small', { text: `to the ${Number(asOf.slice(8))}th` }))),
    h('th', { class: 'total' }, bal ? 'Change in year' : 'Year to date'));

  const body = h('tbody');
  let lastClass = null;
  const span = bal ? 14 : 13;
  for (const r of shown) {
    if (r.class !== lastClass) {
      body.append(h('tr', { class: 'hdr' }, h('td', { class: 'acct', text: r.class }), h('td', { colspan: span })));
      lastClass = r.class;
    }
    const tr = h('tr', {}, h('td', { class: 'acct' }, h('span', { class: 'code', text: r.code }), r.name));
    if (bal) tr.append(h('td', { text: whole(r.openBal) }));
    tb.months.forEach((ym, i) => {
      if (!shownMonth(ym)) { tr.append(h('td', { class: 'empty', text: '·' })); return; }
      const v = cellValue(r, ym), target = drillFor(r, ym), td = h('td');
      if (v !== 0 && target) {
        td.append(h('button', { type: 'button', class: 'cell', text: whole(v),
          'aria-label': `${r.code} ${r.name}, ${MONTH_ABBR[i]}: ${money(v)}. Show this month’s transactions.`, onclick: () => drill(target) }));
      } else td.textContent = whole(v);
      tr.append(td);
    });
    tr.append(h('td', { class: 'total', text: whole(bal ? r.change : r.total) }));
    body.append(tr);
  }
  const totalRow = (label, pick, openPick, ytd, cls) => {
    const tr = h('tr', { class: cls }, h('td', { class: 'acct', text: label }));
    if (bal) tr.append(h('td', { text: whole(openPick) }));
    for (const ym of tb.months) tr.append(shownMonth(ym) ? h('td', { text: whole(pick(ym)) }) : h('td', { class: 'empty', text: '·' }));
    tr.append(h('td', { class: 'total', text: ytd == null ? '' : whole(ytd) }));
    return tr;
  };
  if (bal) {
    body.append(
      totalRow('Total debit balances', ym => tb.bal.byMonth[ym].debit, tb.bal.open.debit, null, 'tot'),
      totalRow('Total credit balances', ym => tb.bal.byMonth[ym].credit, tb.bal.open.credit, null, 'tot2'),
      totalRow('Difference (should be –)', ym => tb.bal.byMonth[ym].difference, tb.bal.open.difference, null, 'net'),
      totalRow('Memo: net income (loss), year to date', ym => tb.netIncomeYtd[ym], 0, null, 'run'));
  } else {
    body.append(
      totalRow('Total debit balances', ym => tb.totals.debit[ym], 0, tb.totals.debitYtd, 'tot'),
      totalRow('Total credit balances', ym => tb.totals.credit[ym], 0, tb.totals.creditYtd, 'tot2'),
      totalRow('Difference (should be –)', ym => tb.totals.difference[ym], 0, tb.totals.differenceYtd, 'net'),
      totalRow('Memo: net income (loss) for the month', ym => tb.netIncome.byMonth[ym], 0, tb.netIncome.total, 'run'));
  }

  const balanced = bal
    ? tb.bal.open.difference === 0 && tb.months.every(ym => !tb.reached[ym] || tb.bal.byMonth[ym].difference === 0)
    : tb.totals.differenceYtd === 0 && tb.months.every(ym => tb.totals.difference[ym] === 0);
  const before = countBeforeOpening(state.txs, state.opening);
  const select = h('select', { id: 'year-tb', 'aria-label': 'Year', onchange: e => { state.year = e.target.value; renderFS(asOf, 'year-tb'); } },
    years.map(y => h('option', { value: y, text: y, selected: y === state.year })));
  fill($('fs-tb'),
    h('div', { class: 'card-head' }, h('h2', { id: 'fs-tb-title', text: bal ? 'Trial balance, month end' : 'Trial balance, monthly activity' }), h('div', { class: 'row-form' }, viewToggle(asOf), select)),
    !tb.hasOpening && h('div', { class: 'notice' }, h('span', { text: 'No opening balances yet, so balances start from zero. Enter what each account held on your opening date to tie to your statements.' }),
      h('button', { class: 'btn', type: 'button', text: 'Enter opening balances', onclick: () => openSettings('opening') })),
    before > 0 && h('p', { class: 'note', text: `${plural(before, 'transaction', 'transactions')} dated on or before ${fmtFull(state.opening.date)} ${before === 1 ? 'is' : 'are'} before the books start and ${before === 1 ? 'isn’t' : 'aren’t'} in this view.` }),
    h('div', { class: 'mx-wrap' }, h('table', { class: 'mx' }, h('thead', {}, head), body)),
    h('div', { class: 'mx-legend' },
      h('span', { class: balanced ? 'ok' : 'bad', text: balanced ? '✓ Every month balances: debits equal credits' : '✗ Out of balance: see the Difference row' }),
      h('span', { text: 'Tap a number to see that month’s transactions. Scroll sideways for more months.' })));
}

function renderBalanceSheet(asOf) {
  const bs = balanceSheet(state.txs, state.year, asOf, state.opening);
  const mo = pickedMonth();
  const mi = mo ? Number(mo.slice(5)) - 1 : -1;
  const shown = ym => bs.reached[ym];
  // The month before the one picked; for January that is last December (or the opening balance).
  const prevBs = mo && mi === 0 ? balanceSheet(state.txs, String(Number(state.year) - 1), asOf, state.opening) : null;
  const prevDec = `${Number(state.year) - 1}-12`;
  const prior = (group, r) => {
    if (mi > 0) return r ? r.byMonth[bs.months[mi - 1]] : group === 'earnings' ? bs.equity.earnings.byMonth[bs.months[mi - 1]] : bs[group].byMonth[bs.months[mi - 1]];
    if (prevBs && prevBs.reached[prevDec]) {
      if (group === 'earnings') return prevBs.equity.earnings.byMonth[prevDec];
      const src = r ? prevBs[group].rows.find(x => x.key === r.key) : prevBs[group];
      return src ? src.byMonth[prevDec] : 0;
    }
    return r ? r.open : group === 'earnings' ? 0 : bs[group].open;
  };

  const cols = mo
    ? [h('th', {}, MONTH_ABBR[mi], bs.partialMonth === mo && h('small', { text: `to the ${Number(asOf.slice(8))}th` })),
       h('th', {}, mi > 0 ? MONTH_ABBR[mi - 1] : 'Prior', h('small', { text: mi > 0 ? 'month end' : 'year end' })),
       h('th', {}, 'Change')]
    : [h('th', {}, 'Opening', h('small', { text: fmtFull(bs.openDate) })),
       bs.months.map((ym, i) => h('th', {}, MONTH_ABBR[i], ym === bs.partialMonth && h('small', { text: `to the ${Number(asOf.slice(8))}th` })))];
  const head = h('tr', {}, h('th', { class: 'acct', style: 'text-align:left', text: 'Account' }), cols);
  const span = mo ? 3 : 13;

  const body = h('tbody');
  const dot = () => h('td', { class: 'empty', text: '·' });
  const header = label => body.append(h('tr', { class: 'hdr' }, h('td', { class: 'acct', text: label }), h('td', { colspan: span })));
  // One line of numbers: either the whole year across, or the month against the month before.
  const numbers = (tr, group, r, t) => {
    const src = r ?? t;
    if (!mo) {
      tr.append(h('td', { text: whole(src.open) }));
      bs.months.forEach((ym, i) => {
        if (!shown(ym)) { tr.append(dot()); return; }
        const v = src.byMonth[ym], target = r && drillFor(r, ym), td = h('td');
        if (r && v !== 0 && target) {
          td.append(h('button', { type: 'button', class: 'cell', text: whole(v),
            'aria-label': `${r.name}, ${MONTH_ABBR[i]}: ${money(v)}. Show this month’s transactions.`, onclick: () => drill(target) }));
        } else td.textContent = whole(v);
        tr.append(td);
      });
      return;
    }
    const cur = src.byMonth[mo], was = prior(group, r);
    if (!shown(mo)) { tr.append(dot(), dot(), dot()); return; }
    const target = r && drillFor(r, mo), td = h('td');
    if (r && cur !== 0 && target) {
      td.append(h('button', { type: 'button', class: 'cell', text: whole(cur),
        'aria-label': `${r.name}, ${MONTH_ABBR[mi]}: ${money(cur)}. Show this month’s transactions.`, onclick: () => drill(target) }));
    } else td.textContent = whole(cur);
    tr.append(td, h('td', { text: whole(was) }), h('td', { text: whole(cur - was) }));
  };
  const accountRow = group => r => {
    const tr = h('tr', {}, h('td', { class: 'acct' }, r.code && h('span', { class: 'code', text: r.code }), r.name));
    numbers(tr, group, r, null);
    body.append(tr);
  };
  const totalRow = (label, group, t, cls) => {
    const tr = h('tr', { class: cls }, h('td', { class: 'acct', text: label }));
    numbers(tr, group, null, t);
    body.append(tr);
  };

  header('Assets');
  bs.assets.rows.forEach(accountRow('assets'));
  totalRow('Total assets', 'assets', bs.assets, 'tot');
  if (bs.liabilities.rows.length) {
    header('Liabilities');
    bs.liabilities.rows.forEach(accountRow('liabilities'));
    totalRow('Total liabilities', 'liabilities', bs.liabilities, 'tot');
  }
  header('Equity');
  bs.equity.rows.forEach(accountRow('equity'));
  const earnings = h('tr', {}, h('td', { class: 'acct', text: 'Current year earnings' }));
  numbers(earnings, 'earnings', null, { open: 0, byMonth: bs.equity.earnings.byMonth });
  body.append(earnings);
  totalRow('Total equity', 'equity', bs.equity, 'tot');
  totalRow('Total liabilities & equity', 'liabilitiesAndEquity', bs.liabilitiesAndEquity, 'tot2');
  totalRow('Difference', 'difference', bs.difference, 'net');

  const balanced = bs.difference.open === 0 && bs.months.every(ym => !shown(ym) || bs.difference.byMonth[ym] === 0);
  fill($('fs-bs'),
    h('div', { class: 'card-head' }, h('h2', { id: 'fs-bs-title', text: mo ? `Balance sheet, ${MONTH_NAMES[mi]} ${state.year}` : `Balance sheet, ${state.year}` }), periodPickers(asOf, 'bs')),
    !bs.hasOpening && h('div', { class: 'notice' }, h('span', { text: 'No opening balances yet, so every balance starts from zero. Enter what each account held on your opening date to tie to your statements.' }),
      h('button', { class: 'btn', type: 'button', text: 'Enter opening balances', onclick: () => openSettings('opening') })),
    h('div', { class: 'mx-wrap' }, h('table', { class: 'mx' }, h('thead', {}, head), body)),
    h('div', { class: 'mx-legend' },
      h('span', { class: balanced ? 'ok' : 'bad', text: balanced ? '✓ Assets = liabilities + equity' : '✗ Out of balance: see the Difference row' }),
      h('span', { text: 'Whole dollars. Tap a number to see its transactions.' })));
}

// ---------- tie-out: where did the cash go? ----------
const swing = c => (c === 0 ? '–' : signed(c));

function savingsMoveForm(msg) {
  const accounts = Object.values(CATEGORIES).filter(c => c.group === 'savings').sort((a, b) => a.code.localeCompare(b.code));
  const add = guard(msg, () => {
    const cents = toCents($('mv-amount').value);
    if (cents <= 0) throw new Error('Enter an amount greater than zero.');
    const date = $('mv-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Choose the date it happened.');
    const catId = $('mv-account').value, out = $('mv-direction').value === 'out';
    const name = CATEGORIES[catId].name;
    const id = `hand-${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2))}`;
    state.raw = [...state.raw, { id, account: 'chase-checking', source: 'manual', byHand: true, date,
      description: `BY HAND: ${out ? 'PULLED FROM' : 'MOVED TO'} ${name.toUpperCase()}`, cents: out ? cents : -cents }];
    state.overrides[id] = catId;
    recompute(); render(); markDirty();
    msg.className = 'msg'; msg.textContent = `Logged: ${out ? 'pulled' : 'moved'} ${money(cents)} ${out ? 'from' : 'to'} ${name}.`;
  });
  return h('details', { class: 'fine' }, h('summary', { text: 'Log a savings move that isn’t on a statement' }),
    h('div', { style: 'display:flex;flex-direction:column;gap:8px;padding-top:6px' },
      h('p', { class: 'note', text: 'Use this when money moved between checking and a savings account and you won’t import that account’s statement. If the move will also appear on a statement you import, don’t log it, or it counts twice.' }),
      h('div', { class: 'row-form' },
        h('select', { id: 'mv-direction', 'aria-label': 'Direction' },
          h('option', { value: 'out', text: 'Pulled out of savings into checking' }), h('option', { value: 'in', text: 'Moved from checking into savings' })),
        h('select', { id: 'mv-account', 'aria-label': 'Savings account' }, accounts.map(c => h('option', { value: c.id, text: `${c.code} ${c.name}` }))),
        h('input', { id: 'mv-amount', type: 'text', inputmode: 'decimal', placeholder: 'Amount', 'aria-label': 'Amount', style: 'width:110px' }),
        h('input', { id: 'mv-date', type: 'date', 'aria-label': 'Date', value: asOfDate(state.txs) }),
        h('button', { class: 'btn', type: 'button', text: 'Add', onclick: add }))));
}

function renderTie() {
  const months = [...new Set(state.txs.filter(t => t.date > state.opening.date).map(t => monthOf(t.date)))].sort().reverse();
  const asOf = asOfDate(state.txs);
  if (!months.length) {
    fill($('tie'), h('h2', { id: 'tie-title', text: 'Where the cash went' }), h('p', { class: 'sub', text: `Nothing is dated after your opening date, ${fmtFull(state.opening.date)}. Change the opening date in Settings.` }));
    fill($('tie-plan')); fill($('tie-savings'));
    return;
  }
  if (!state.tie || (state.tie !== 'ytd' && !months.includes(state.tie))) state.tie = months[0];
  const ytd = state.tie === 'ytd';
  const t = tieOut(state.txs, plan, ytd ? { kind: 'year', year: asOf.slice(0, 4) } : { kind: 'month', ym: state.tie }, asOf, state.opening);
  const label = ytd ? `${asOf.slice(0, 4)} to date` : fmtMonth(state.tie);
  const partial = !ytd && state.tie === monthOf(asOf) && Number(asOf.slice(8)) < new Date(Date.UTC(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)), 0)).getUTCDate();

  const select = h('select', { id: 'tie-period', 'aria-label': 'Period', onchange: e => { state.tie = e.target.value; renderTie(); } },
    months.map(ym => h('option', { value: ym, text: fmtMonth(ym), selected: ym === state.tie })),
    h('option', { value: 'ytd', text: `${asOf.slice(0, 4)} to date`, selected: ytd }));

  const row = (text, cents, cls = '') => h('tr', { class: cls }, h('td', { text }), h('td', { class: 'num', text: swing(cents) }));
  const flow = h('table', { class: 'tie' }, h('tbody', {},
    row('Take-home pay & other income', t.effect.income),
    t.effect.other !== 0 && row('Interest, fees & other', t.effect.other),
    row('Fixed bills', t.effect.fixed), row('Subscriptions', t.effect.subscriptions), row('Free cash spending', t.effect.free),
    t.effect.onetime !== 0 && row('One-time purchases & annual fees', t.effect.onetime),
    t.effect.vacation !== 0 && row('Vacations', t.effect.vacation),
    t.effect.review !== 0 && row('Needs review (not yet classified)', t.effect.review),
    row('Net income (loss)', t.netIncome, 'sum'),
    t.savings.map(a => row(`Moved to ${a.name}`, -a.net)),
    t.float !== 0 && row(t.float > 0 ? 'Card charges not yet paid' : 'Paid down earlier card balances', t.float),
    t.clearing !== 0 && row('Transfers in transit', t.clearing),
    row('Change in checking cash', t.cashChange, 'sum big')));

  const plan2 = h('table', { class: 'tie' },
    h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { class: 'num', text: 'Plan' }), h('th', { class: 'num', text: 'Actual' }), h('th', { class: 'num', text: 'Cash effect' }))),
    h('tbody', {}, t.vsPlan.filter(l => l.planned !== 0 || l.actual !== 0 || l.effect !== 0).map(l =>
      h('tr', {}, h('td', { text: l.label }), h('td', { class: 'num', text: l.planned ? money(l.planned) : '–' }), h('td', { class: 'num', text: swing(l.actual) === '–' ? '–' : money(l.actual) }), h('td', { class: 'num', text: swing(l.effect) }))),
      h('tr', { class: 'sum big' }, h('td', { text: 'Change in checking cash' }), h('td', { class: 'num', text: '–' }), h('td', { class: 'num' }), h('td', { class: 'num', text: swing(t.vsPlanTotal) }))));

  const o = t.overspend;
  const names = t.savings.filter(a => a.pulledOut > 0).map(a => a.name).join(', ');
  const answer = o.over === 0
    ? [`Free cash is on or under plan${o.free.planned - o.free.actual > 0 ? ` (${money(o.free.planned - o.free.actual)} to spare)` : ''}, so nothing needs covering.`]
    : [
      `Free cash is ${money(o.over)} over plan.`,
      o.pulledOut > 0 ? `${money(o.pulledOut)} came out of savings (${names}).` : 'No money left a savings account in this period.',
      t.cashChange < 0 ? `Checking cash is down ${money(-t.cashChange)}.` : null,
      o.movedLess > 0 ? `You moved ${money(o.movedLess)} less into savings than planned.` : null,
    ].filter(Boolean);

  const savingsTable = t.savings.length
    ? h('table', { class: 'tie' },
        h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { class: 'num', text: 'Moved in' }), h('th', { class: 'num', text: 'Pulled out' }), h('th', { class: 'num', text: 'Net' }))),
        h('tbody', {}, t.savings.map(a => h('tr', {}, h('td', {}, h('span', { class: 'code', text: a.code }), a.name),
          h('td', { class: 'num', text: a.movedIn ? money(a.movedIn) : '–' }), h('td', { class: 'num', text: a.pulledOut ? money(a.pulledOut) : '–' }), h('td', { class: 'num', text: swing(a.net) })))))
    : h('p', { class: 'note', text: 'No money moved into or out of savings in this period.' });

  const msg = h('p', { class: 'msg', role: 'status' });
  fill($('tie'),
    h('div', { class: 'card-head' }, h('h2', { id: 'tie-title', text: 'Where the cash went' }), select),
    h('p', { class: 'sub', text: `${label}. Every dollar of change in your checking account, explained.${partial ? ` Your plan is scaled to the first ${Number(asOf.slice(8))} days.` : ''}` }),
    flow,
    h('p', { class: t.ties ? 'check ok' : 'check bad', text: t.ties ? '✓ Ties to your checking account activity' : `✗ Doesn’t tie: checking moved ${swing(t.checking)}, the ledger says ${swing(t.cashChange)}` }));
  fill($('tie-plan'),
    h('h2', { text: 'Against your plan' }),
    h('p', { class: 'sub', text: 'Your plan expects checking cash to stay flat. Each line shows what pushed it up or down instead.' }),
    plan2);
  fill($('tie-savings'),
    h('h2', { text: 'Savings accounts' }),
    savingsTable,
    h('p', { class: 'answer', text: answer.join(' ') }),
    savingsMoveForm(msg), msg);
}

// ---------- month-by-month table ----------
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const whole = c => {
  const n = Math.round(Math.abs(c) / 100);
  if (n === 0) return '\u2013';
  const txt = n.toLocaleString('en-US');
  return c < 0 ? `(${txt})` : txt;
};

function renderMatrix(asOf) {
  const m = monthlyMatrix(state.txs, state.year, asOf);
  const mo = pickedMonth();
  const mi = mo ? Number(mo.slice(5)) - 1 : -1;
  const isPartial = ym => ym === m.partialMonth;
  const partialNote = ym => isPartial(ym) && h('small', { text: `to the ${Number(asOf.slice(8))}th` });
  const ytdOf = l => m.months.filter(ym => ym <= mo).reduce((sum, ym) => sum + (l.byMonth[ym] ?? 0), 0);

  const head = mo
    ? h('tr', {}, h('th', { class: 'acct', style: 'text-align:left', text: 'GL account' }),
        h('th', {}, MONTH_ABBR[mi], partialNote(mo)),
        h('th', { class: 'total' }, 'Year to date', h('small', { text: `through ${MONTH_ABBR[mi]}` })))
    : h('tr', {}, h('th', { class: 'acct', style: 'text-align:left', text: 'GL account' }),
        m.months.map((ym, i) => h('th', {}, MONTH_ABBR[i], partialNote(ym))),
        h('th', { class: 'avg' }, 'Avg / mo', h('small', { text: 'full months' })),
        h('th', { class: 'total' }, 'Year to date'));

  const body = h('tbody');
  const span = mo ? 3 : 14;
  const drillCell = (l, ym, v) => {
    const td = h('td');
    if (l.kind === 'row' && v !== 0) {
      td.append(h('button', { type: 'button', class: 'cell', text: whole(v), 'aria-label': `${l.name}, ${MONTH_ABBR[Number(ym.slice(5)) - 1]}: ${money(v)}. Show these transactions.`,
        onclick: () => drill({ type: 'category', id: l.id, ym }) }));
    } else td.textContent = whole(v);
    return td;
  };
  for (const l of m.lines) {
    if (l.kind === 'header') {
      body.append(h('tr', { class: 'hdr' }, h('td', { class: 'acct', text: l.code ? `${l.code}  ${l.label}` : l.label }), h('td', { colspan: span })));
      continue;
    }
    if (mo && l.kind === 'running') continue;
    const cls = { row: '', subtotal: 'tot', net: 'net', running: 'run' }[l.kind];
    const tr = h('tr', { class: cls }, h('td', { class: 'acct' }, l.code && h('span', { class: 'code', text: l.code }), l.name ?? l.label));
    if (mo) {
      tr.append(m.hasData[mo] ? drillCell(l, mo, l.byMonth[mo]) : h('td', { class: 'empty', text: '·' }), h('td', { class: 'total', text: whole(ytdOf(l)) }));
      body.append(tr);
      continue;
    }
    m.months.forEach(ym => {
      const v = l.byMonth[ym];
      if (v === null || (!m.hasData[ym])) { tr.append(h('td', { class: 'empty', text: '·' })); return; }
      let tone = '';
      if (l.kind === 'row' && l.group !== 'income' && m.fullMonthCount >= 3 && !isPartial(ym) && l.avg > 0) {
        const off = v - l.avg;
        if (Math.abs(off) >= Math.max(5000, l.avg * 0.25)) tone = off > 0 ? 'hi' : 'lo';
      }
      const td = drillCell(l, ym, v);
      if (tone) td.className = tone;
      tr.append(td);
    });
    if (l.kind === 'running') { tr.append(h('td', { class: 'avg' }), h('td', { class: 'total' })); }
    else { tr.append(h('td', { class: 'avg', text: whole(l.avg) }), h('td', { class: 'total', text: whole(l.total) })); }
    body.append(tr);
  }

  fill($('fs-is'),
    h('div', { class: 'card-head' }, h('h2', { id: 'fs-is-title', text: mo ? `Income statement, ${MONTH_NAMES[mi]} ${state.year}` : `Income statement, ${state.year}` }), periodPickers(asOf, 'is')),
    h('div', { class: 'mx-wrap' }, h('table', { class: 'mx' }, h('thead', {}, head), body)),
    h('div', { class: 'mx-legend' },
      !mo && m.fullMonthCount >= 3 && h('span', {}, h('i', { style: 'background:var(--tint-watch)' }), 'Well above that line’s monthly average'),
      !mo && m.fullMonthCount >= 3 && h('span', {}, h('i', { style: 'background:var(--tint-good)' }), 'Well below it'),
      h('span', { text: 'Whole dollars. Tap a number to see its transactions.' })));
}

// ---------- tabs and the main render ----------
const TABS = ['summary', 'budget', 'investments', 'savings', 'fs', 'tie'];
const TAB_LABELS = { summary: 'Summary', budget: 'Budget', investments: 'Investments', savings: 'Savings', fs: 'F/S', tie: 'Tie-out' };
const NEEDS_DATA = new Set(['budget', 'fs', 'tie']); // the other tabs are placeholders for now
// The pages inside F/S, in the order you read them.
const FS_PAGES = [['tb', 'TB Summary'], ['bs', 'Balance Sheet'], ['is', 'Income Statement'], ['gl', 'GL Detail']];

function applyTab() {
  const has = state.txs.length > 0;
  for (const name of TABS) {
    $(`tab-${name}`).setAttribute('aria-selected', String(state.tab === name));
    $(`panel-${name}`).hidden = state.tab !== name || (NEEDS_DATA.has(name) && !has);
  }
  for (const [id] of FS_PAGES) $(`page-${id}`).hidden = state.fsPage !== id;
  $('fs-page').value = state.fsPage;
  $('empty').hidden = has || !NEEDS_DATA.has(state.tab);
}

function setTab(tab) {
  state.tab = tab;
  if (!(tab === 'fs' && state.fsPage === 'gl')) state.returnTo = null;
  if (tab === 'fs' && state.fsPage === 'gl' && state.txs.length) renderLedger();
  if (tab === 'budget' && state.txs.length) renderBudget(asOfDate(state.txs), false);   // redraw the charts at this screen's width
  applyTab();
}
for (const name of TABS) $(`tab-${name}`).addEventListener('click', () => setTab(name));

function setFsPage(page) {
  state.fsPage = page;
  if (page !== 'gl') state.returnTo = null;
  if (page === 'gl' && state.txs.length) renderLedger();
  applyTab();
}
$('fs-page').addEventListener('change', e => setFsPage(e.target.value));

// Coming back from a drill-down returns to the page you came from, and drops its filter so GL Detail isn't left showing one slice.
$('gl-back').addEventListener('click', () => {
  const back = state.returnTo;
  state.returnTo = null; resetGl();
  if (back?.tab === 'fs') state.fsPage = back.page;
  setTab(back?.tab ?? 'budget');
});
$('empty-settings').addEventListener('click', () => openSettings('saving'));
$('banner-btn').addEventListener('click', () => { openSettings('saving'); $('sec-pass')?.focus(); });

function render() {
  renderSaveState();
  $('lock').hidden = !state.locked;
  $('app').hidden = state.locked;
  $('add-btn').hidden = state.locked || state.demo;
  if (state.locked) {
    for (const id of ['bgt-summary', 'bgt-weeks', 'bgt-savings', 'monthcard', 'where', 'habits', 'fs-tb', 'fs-bs', 'fs-is', 'plan-body', 'chips', 'gl-controls', 'coverage']) $(id).replaceChildren();
    $('out').querySelector('tbody').replaceChildren();
    $('gl-count').textContent = '';
    $('settings-body').replaceChildren();
    $('asof').textContent = 'Locked.';
    return;
  }
  const has = state.txs.length > 0;
  if (!has) {
    $('asof').textContent = 'Your weekly and monthly spending, in one place.';
  } else {
    const asOf = asOfDate(state.txs);
    const sample = JSON.stringify(plan) === JSON.stringify(samplePlan);
    $('asof').textContent = `Through ${fmtDate(asOf)}.` + (sample && !state.demo ? ' Using a sample plan until you set your own under Your plan.' : '');
    renderBudget(asOf, false);
    renderLedger();
    renderFS(asOf);
    renderTie();
  }
  if (!document.activeElement?.closest('#plan-body')) renderPlan();   // don't rebuild the form while you type in it
  updatePlanSummary();
  applyTab();
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.txs.length && !state.locked && state.tab === 'budget') renderBudget(asOfDate(state.txs), false); }, 150);
});

// ---------- your plan (inside the Budget tab, collapsed) ----------
const dollars = c => (c / 100).toFixed(2).replace(/\.00$/, '');
const guard = (msgEl, fn) => async (...args) => {
  msgEl.className = 'msg'; msgEl.textContent = '';
  try { await fn(...args); } catch (err) { msgEl.className = 'msg error'; msgEl.textContent = err.message; }
};

function planFieldDefs() {
  const idsIn = g => Object.values(CATEGORIES).filter(c => c.group === g && !isRemoved(c.id)).sort((a, b) => a.code.localeCompare(b.code));
  const planned = cat => ({
    id: cat.id, label: `${cat.code} ${cat.name}`,
    get: () => plan.planned?.[cat.id] ?? 0,
    set: (p, c) => { p.planned = p.planned ?? {}; if (c) p.planned[cat.id] = c; else delete p.planned[cat.id]; },
  });
  return [
    { heading: 'Take-home pay each month', fields: [{ id: 'income', label: 'After tax and 401(k)', get: () => plan.income, set: (p, c) => { p.income = c; } }] },
    ...[['fixed', 'Fixed monthly expenses'], ['subscriptions', 'Subscriptions'], ['onetime', 'Set aside for one-time purchases & annual fees'], ['savings', 'Savings & investing moved each month']]
      .map(([g, heading]) => ({ heading, fields: idsIn(g).map(planned) })),
    { heading: 'Vacations', fields: [{ id: 'vacation', label: 'Set aside for trips each month', get: () => plan.vacation ?? 0, set: (p, c) => { p.vacation = c; } }] },
  ];
}

// Dollars ("1,200") or a percentage of take-home ("15%").
function parseAmount(text, fieldId) {
  const t = text.trim();
  if (t === '') return 0;
  if (t.endsWith('%')) {
    const pct = Number(t.slice(0, -1));
    if (fieldId === 'income' || !Number.isFinite(pct) || pct < 0) throw new Error('bad');
    return Math.round(plan.income * pct / 100);
  }
  const c = toCents(t);
  if (c < 0) throw new Error('bad');
  return c;
}

function changePlan(mutate) {
  const next = JSON.parse(JSON.stringify(plan));
  mutate(next);
  validatePlan(next);
  plan = next;
  render();
  markDirty();
}

function renderPlan() {
  const rows = [];
  for (const group of planFieldDefs()) {
    rows.push(h('h3', { class: 'set-h', text: group.heading }));
    for (const f of group.fields) {
      rows.push(
        h('label', { for: `plan-${f.id}`, text: f.label }),
        h('input', { id: `plan-${f.id}`, type: 'text', inputmode: 'decimal', value: dollars(f.get()), 'aria-describedby': `pct-${f.id}`,
          onchange: e => {
            try { const c = parseAmount(e.target.value, f.id); changePlan(p => f.set(p, c)); e.target.value = dollars(f.get()); e.target.classList.remove('bad'); }
            catch { e.target.classList.add('bad'); }
          } }),
        h('span', { class: 'pct', id: `pct-${f.id}` }));
    }
  }
  fill($('plan-body'),
    h('p', { class: 'sub', style: 'margin:4px 0 10px', text: 'What comes in and what you set aside each month. Free cash is whatever is left, and it sets your weekly target. Type dollars, or a percentage of take-home like 15%.' }),
    h('div', { class: 'field-grid plan' }, rows),
    h('p', { class: 'free-line', id: 'plan-summary', style: 'margin-top:10px' }));
  updatePlanSummary();
}

function updatePlanSummary() {
  const free = plannedFreeCash(plan);
  $('plan-line').textContent = `Your plan · free cash ${money(free)} a month`;
  const el = $('plan-summary');
  if (el) {
    el.textContent = free >= 0
      ? `Free cash: ${money(free)} a month, about ${money(Math.round(free * 12 / 52))} a week.`
      : `This plan spends ${money(free)} more than your take-home each month.`;
  }
  for (const group of planFieldDefs()) {
    for (const f of group.fields) {
      const span = $(`pct-${f.id}`);
      if (span) span.textContent = f.id === 'income' || plan.income <= 0 ? '' : `${(f.get() / plan.income * 100).toFixed(1)}%`;
    }
  }
}

function openPlan() {
  setTab('budget');
  const d = $('plan-details');
  d.open = true;
  d.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

// ---------- dummy numbers ----------
const DEMO_KEY = 'my-budget-demo';
const readDemoFlag = () => { try { return localStorage.getItem(DEMO_KEY) === '1'; } catch { return false; } };
const writeDemoFlag = on => { try { if (on) localStorage.setItem(DEMO_KEY, '1'); else localStorage.removeItem(DEMO_KEY); } catch { /* storage unavailable: demo just won't survive a reload */ } };

// Swaps your data for made-up numbers. If a passphrase protects your data, it is locked away again
// (so turning dummy numbers off needs the passphrase); otherwise it waits in memory.
async function enableDemo() {
  await flushSave();
  if (state.vault) {
    const env = await storage.load();
    if (!env) throw new Error("Couldn't reach your saved data, so dummy numbers can't start safely.");
    state.envelope = env; state.vault = null; state.stash = null;
  } else if (!state.envelope) {
    state.stash = snapshot();
  }
  clearMemory();
  loadSnapshot(dummySnapshot());
  state.demo = true; state.demoAsk = false; state.save = 'idle'; state.tab = 'budget';
  writeDemoFlag(true);
  $('status').textContent = 'Showing dummy numbers. Your own data is not on screen.';
  recompute(); render(); renderSettingsScreen();
}

async function disableDemo(pass = '') {
  if (state.envelope) {
    const { vault, data } = await unlock(state.envelope, pass);     // throws on a wrong passphrase
    loadSnapshot(data);
    state.vault = vault; state.envelope = null; state.save = 'saved';
  } else if (state.stash) {
    loadSnapshot(state.stash); state.stash = null;
  } else {
    clearMemory();
  }
  state.demo = false; state.demoAsk = false;
  writeDemoFlag(false);
  $('status').textContent = '';
  recompute(); render(); renderSettingsScreen();
}

async function toggleDemo() {
  if (!state.demo) return enableDemo();
  if (state.envelope) { state.demoAsk = true; renderSettingsScreen(); $('demo-pass')?.focus(); return; }
  return disableDemo();
}

// ---------- settings: a small sheet behind the gear ----------
const SETTINGS_TITLES = { home: 'Settings', opening: 'Opening balances', coding: 'TB coding', trips: 'Trips', saving: 'Saving & backup' };

function openSettings(screen = 'home') {
  state.settingsScreen = screen;
  $('settings').hidden = false;
  document.body.classList.add('noscroll');
  renderSettingsScreen();
  $('settings-close').focus();
}
function closeSettings() {
  $('settings').hidden = true;
  document.body.classList.remove('noscroll');
  state.demoAsk = false;
  $('gear').focus();
}
$('gear').addEventListener('click', () => openSettings());
$('settings-close').addEventListener('click', closeSettings);
$('settings').addEventListener('click', e => { if (e.target === $('settings')) closeSettings(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('settings').hidden) closeSettings(); });
$('settings-back').addEventListener('click', () => { state.settingsScreen = 'home'; renderSettingsScreen(); });

function renderSettingsScreen() {
  const screen = state.settingsScreen;
  $('settings-title').textContent = SETTINGS_TITLES[screen];
  $('settings-back').hidden = screen === 'home';
  const body = $('settings-body');
  body.replaceChildren();
  ({ home: renderHomeScreen, opening: renderOpeningScreen, coding: renderCodingScreen, trips: renderTripsScreen, saving: renderSavingScreen })[screen](body);
}

function renderHomeScreen(body) {
  const go = (title, sub, screen) => h('button', { type: 'button', class: 'menu-row', onclick: () => { state.settingsScreen = screen; renderSettingsScreen(); } },
    h('span', {}, title, h('small', { text: sub })), h('span', { class: 'chev', text: '›', 'aria-hidden': 'true' }));
  const msg = h('p', { class: 'msg', role: 'status' });
  const asking = state.demo && state.demoAsk;
  body.append(...[h('div', { class: 'menu' },
    go('Opening balances', `Where each account stood on ${fmtFull(state.opening.date)}`, 'opening'),
    go('TB coding', 'Map each account to your TB numbers', 'coding'),
    go('Trips', 'Vacation blocks, 7100 to 7900', 'trips'),
    go('Saving & backup', 'Passphrase, encrypted backup, restore', 'saving'),
    h('div', { class: 'menu-row' },
      h('span', {}, 'Dummy numbers', h('small', { text: 'Show made-up numbers instead of yours, for showing friends. Turning it off needs your passphrase.' })),
      h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(state.demo), 'aria-label': 'Dummy numbers', id: 'demo-switch', onclick: guard(msg, toggleDemo) }))),
    asking && h('form', { class: 'row-form', style: 'margin-top:10px', onsubmit: e => { e.preventDefault(); guard(msg, () => disableDemo($('demo-pass').value))(); } },
      h('input', { id: 'demo-pass', type: 'password', autocomplete: 'current-password', placeholder: 'Your passphrase', 'aria-label': 'Passphrase' }),
      h('button', { class: 'btn', type: 'submit', text: 'Show my data' })),
    msg].filter(Boolean));
}

function renderOpeningScreen(body) {
  const msg = h('p', { class: 'msg', role: 'status' });
  const plug = h('p', { class: 'free-line', id: 'open-plug' });
  const update = () => {
    const have = openingAccounts().filter(a => a.side === 'asset').reduce((s, a) => s + (state.opening.balances[a.key] ?? 0), 0);
    const owe = openingAccounts().filter(a => a.side === 'liability').reduce((s, a) => s + (state.opening.balances[a.key] ?? 0), 0);
    plug.textContent = `Opening balance equity: ${money(have - owe)} (what you have, ${money(have)}, less what you owe, ${money(owe)}).`;
  };
  const save = () => { render(); markDirty(); update(); };
  const field = a => {
    const id = `open-${a.key.replace(':', '-')}`;
    return [h('label', { for: id, text: `${a.code} ${a.name}` }),
      h('input', { id, type: 'text', inputmode: 'decimal', value: dollars(state.opening.balances[a.key] ?? 0), onchange: e => {
        try {
          const c = e.target.value.trim() === '' ? 0 : toCents(e.target.value);
          if (c < 0) throw new Error('negative');
          const balances = { ...state.opening.balances };
          if (c) balances[a.key] = c; else delete balances[a.key];
          state.opening = { ...state.opening, balances };
          e.target.value = dollars(c); e.target.classList.remove('bad'); msg.textContent = ''; save();
        } catch { e.target.classList.add('bad'); msg.className = 'msg error'; msg.textContent = 'Enter an amount like 1,250.00. Use a positive number for what you have and for what you owe.'; }
      } })];
  };
  const accounts = openingAccounts();
  update();
  body.append(
    h('p', { class: 'sub', text: 'Where each account stood at the end of your opening date. Enter what you have in each account, and what you owe on each card, as they read on the statement. Anything dated on or before this date is left out of TB Summary and Tie-out.' }),
    h('div', { class: 'row-form', style: 'margin:10px 0' },
      h('label', { for: 'open-date', text: 'Opening date', style: 'font-size:14px' }),
      h('input', { id: 'open-date', type: 'date', value: state.opening.date, onchange: e => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { e.target.value = state.opening.date; return; }
        state.opening = { ...state.opening, date: e.target.value }; msg.textContent = ''; save();
      } })),
    h('div', { class: 'field-grid' },
      h('h3', { class: 'set-h', text: 'What you have' }), accounts.filter(a => a.side === 'asset').map(field),
      h('h3', { class: 'set-h', text: 'What you owe' }), accounts.filter(a => a.side === 'liability').map(field)),
    plug, msg);
}

let removingKey = null;   // the account whose delete panel is open on the TB coding screen
function renderCodingScreen(body) {
  const msg = h('p', { class: 'msg', role: 'status' });
  const refresh = focusId => { recompute(); render(); markDirty(); renderSettingsScreen(); if (focusId) document.getElementById(focusId)?.focus(); };
  const change = (key, value, input) => {
    try {
      state.coding = setCode(state.coding, key, value);
      refresh(`code-${key}`);
    } catch (err) {
      input.value = codingList(state.trips, state.coding, state.names).find(r => r.key === key).code;
      input.classList.add('bad');
      msg.className = 'msg error'; msg.textContent = err.message;
    }
  };
  const rename = (key, value, input) => {
    try {
      state.names = setName(state.names, key, value);
      refresh(`name-${key}`);
    } catch (err) {
      input.value = codingList(state.trips, state.coding, state.names).find(r => r.key === key).name;
      input.classList.add('bad');
      msg.className = 'msg error'; msg.textContent = err.message;
    }
  };
  const list = codingList(state.trips, state.coding, state.names);

  // Add a sub account: it takes the next free number below the account you pick.
  const parents = list.filter(r => r.canAddSub);
  const parentSel = h('select', { id: 'sub-parent', 'aria-label': 'Add under' },
    parents.map(r => h('option', { value: r.key, text: `${r.code} ${r.name}` })));
  const subName = h('input', { id: 'sub-name', type: 'text', maxlength: '60', placeholder: 'Sub account name', 'aria-label': 'Sub account name' });
  const addIt = () => {
    try {
      const out = addSub(state.customs, state.coding, parentSel.value, subName.value);
      state.customs = out.customs;
      recompute(); render(); markDirty(); renderSettingsScreen();
      const m = document.querySelector('#settings-body .msg');
      if (m) { m.className = 'msg'; m.textContent = `Added ${out.code} ${subName.value.trim()}.`; }
      document.getElementById('sub-name')?.focus();
    } catch (err) { msg.className = 'msg error'; msg.textContent = err.message; }
  };
  subName.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addIt(); } });

  // Delete = merge: everything filed under the account (and its planned amount) moves into the one you pick.
  const deletePanel = r => {
    const targets = removeTargets(r.key);
    const pick = h('select', { id: 'del-target', 'aria-label': `Move ${r.name} into` }, targets.map(t => h('option', { value: t.key, text: `${t.code} ${t.name}` })));
    return h('div', { class: 'del-panel' },
      h('span', { text: `Move everything in ${r.code} ${r.name} into:` }), pick,
      h('span', { class: 'row-actions' },
        h('button', { type: 'button', class: 'btn danger small', text: 'Delete account', onclick: () => {
          try {
            state.removed = removeAccount(state.removed, r.key, pick.value);
            if (plan.planned?.[r.key]) {            // its planned amount goes with it
              const planned = { ...plan.planned };
              planned[pick.value] = (planned[pick.value] ?? 0) + planned[r.key]; delete planned[r.key];
              plan = { ...plan, planned };
            }
            removingKey = null;
            refresh();
            const m = document.querySelector('#settings-body .msg');
            if (m) { m.className = 'msg'; m.textContent = `Deleted ${r.code} ${r.name}. Everything in it moved to ${CATEGORIES[pick.value].code} ${CATEGORIES[pick.value].name}.`; }
          } catch (err) { msg.className = 'msg error'; msg.textContent = err.message; }
        } }),
        h('button', { type: 'button', class: 'btn ghost small', text: 'Cancel', onclick: () => { removingKey = null; renderSettingsScreen(); } })));
  };
  const gone = removedList();

  const rows = [];
  for (const cls of [...new Set(list.map(r => r.class))]) {
    rows.push(h('h3', { class: 'set-h', text: cls }));
    for (const r of list.filter(x => x.class === cls)) {
      rows.push(h('div', { class: 'code-row' + (r.custom ? ' sub' : '') },
        r.editable
          ? h('input', { id: `code-${r.key}`, type: 'text', inputmode: 'numeric', maxlength: '4', value: r.code, class: r.changed ? 'changed' : '',
              'aria-label': `TB number for ${r.name}`, onchange: e => change(r.key, e.target.value, e.target) })
          : h('span', { class: 'code fixed', text: r.code }),
        r.renamable
          ? h('input', { id: `name-${r.key}`, type: 'text', maxlength: '60', value: r.name, class: 'name' + (r.renamed ? ' changed' : ''),
              'aria-label': `Name of account ${r.code}`, onchange: e => rename(r.key, e.target.value, e.target) })
          : h('span', { text: r.name }),
        h('span', { class: 'row-actions' },
          r.canAddSub && h('button', { type: 'button', class: 'btn ghost small', text: '+ Sub', 'aria-label': `Add a sub account under ${r.code} ${r.name}`,
            onclick: () => { parentSel.value = r.key; subName.focus(); subName.scrollIntoView({ block: 'center' }); } }),
          r.canRemove && h('button', { type: 'button', class: 'btn ghost danger small', text: 'Delete', 'aria-label': `Delete ${r.code} ${r.name}`,
            onclick: () => { removingKey = removingKey === r.key ? null : r.key; renderSettingsScreen(); } }),
          r.custom
            ? twoStep('Remove', 'Tap again', () => {
                const out = removeSub(state.customs, r.key);
                state.customs = out.customs;
                for (const [tid, cat] of Object.entries(state.overrides)) if (out.removed.includes(cat)) delete state.overrides[tid];
                refresh();
              }, 'btn ghost danger small')
            : h('span', { class: 'coa-status' + (r.status === 'Planned' ? ' planned' : ''), text: r.changed ? 'Changed' : r.status }))));
      if (removingKey === r.key && r.canRemove) rows.push(deletePanel(r));
    }
  }
  body.append(
    h('p', { class: 'sub', text: 'Rename any account, change its number, or delete it (its transactions move into another account of the same kind, and you can restore it later). Numbers are 4 digits and used once. A sub account takes the next free number below its parent: under 1100 you get 1110, then 1120; under 5110, 5111, 5112.' }),
    msg,
    h('div', { class: 'row-form sub-add' }, parentSel, subName, h('button', { type: 'button', class: 'btn', text: 'Add sub account', onclick: addIt })),
    h('div', {}, rows),
    h('div', { class: 'row-form', style: 'margin-top:12px' },
      twoStep('Reset numbers and names to the defaults', 'Tap again to reset', () => {
        state.coding = {}; state.names = {}; refresh();
      })),
    gone.length > 0 && h('div', {}, h('h3', { class: 'set-h', text: 'Deleted accounts' }),
      gone.map(g => h('div', { class: 'code-row' },
        h('span', { class: 'code fixed', text: g.code }), h('span', { text: `${g.name} → ${CATEGORIES[g.into].name}` }),
        h('button', { type: 'button', class: 'btn ghost small', text: 'Restore', 'aria-label': `Restore ${g.name}`,
          onclick: () => { state.removed = restoreAccount(state.removed, g.key); refresh(); } })))),
    state.customs.length > 0 && h('p', { class: 'note', text: 'Removing a sub account sends anything filed under it back to automatic categories.' }));
}

function renderTripsScreen(body) {
  const msg = h('p', { class: 'msg', id: 'trip-msg', role: 'status' });
  const add = guard(msg, () => {
    state.trips = addTrip(state.trips, { name: $('trip-name').value, start: $('trip-start').value, end: $('trip-end').value });
    recompute(); render(); renderSettingsScreen(); markDirty();
  });
  body.append(
    h('p', { class: 'sub', text: `Each trip gets its own block of accounts: the first is 7100 (lodging 7110, flights 7120, food 7130, entertainment 7140 and so on), the second 7200, up to ${MAX_TRIPS}. Vacation charges file under the trip they fall in, from 45 days before to 10 days after. Change any single one from GL Detail.` }),
    state.trips.length
      ? h('div', {}, state.trips.map(t => h('div', { class: 'trip' },
          h('span', { class: 'code', text: `7${t.slot}00` }),
          h('div', {}, h('b', { text: t.name }), h('div', { class: 'sub', text: `${fmtDate(t.start)} to ${fmtDate(t.end)}` })),
          twoStep('Remove', 'Tap again to remove', guard(msg, () => { state.trips = removeTrip(state.trips, t.slot); recompute(); render(); renderSettingsScreen(); markDirty(); }), 'btn ghost'))))
      : h('p', { class: 'note', text: 'No trips yet. Vacation charges sit under "No trip yet" (7000) until you add one.' }),
    h('div', { class: 'row-form', style: 'margin-top:10px' },
      h('input', { id: 'trip-name', type: 'text', placeholder: 'Trip name', 'aria-label': 'Trip name' }),
      h('input', { id: 'trip-start', type: 'date', 'aria-label': 'Trip start' }),
      h('input', { id: 'trip-end', type: 'date', 'aria-label': 'Trip end' }),
      h('button', { class: 'btn', type: 'button', text: 'Add trip', onclick: add })),
    msg);
}

function renderSavingScreen(body) {
  const msg = h('p', { class: 'msg', id: 'sec-msg', role: 'status' });
  const kids = [];

  if (state.demo) {
    kids.push(h('p', { class: 'sub', text: 'Dummy numbers are on, so your own data is locked away. Turn them off (it needs your passphrase) to manage saving and backup.' }));
  } else if (PREVIEW) {
    kids.push(h('p', { class: 'sub', text: 'This preview page keeps everything in memory and saves nothing. The real app saves your data on this device, encrypted with your passphrase.' }));
  } else if (!state.vault) {
    kids.push(
      h('p', { class: 'sub', text: 'Choose a passphrase to save your statements, plan and trips on this device. Everything is encrypted with it before it is stored. If you forget it, nobody can recover the data, so also download a backup.' }),
      h('div', { class: 'row-form' },
        h('input', { id: 'sec-pass', type: 'password', autocomplete: 'new-password', placeholder: 'New passphrase', 'aria-label': 'New passphrase' }),
        h('input', { id: 'sec-pass2', type: 'password', autocomplete: 'new-password', placeholder: 'Type it again', 'aria-label': 'Repeat passphrase' }),
        h('button', { class: 'btn', type: 'button', text: 'Save on this device', onclick: guard(msg, async () => {
          await setPassphrase($('sec-pass').value, $('sec-pass2').value);
          render(); renderSettingsScreen();
        }) })));
  } else {
    kids.push(
      h('p', { class: 'sub', text: `Your data is saved on this device and encrypted. ${state.persisted ? 'The browser has agreed to keep it.' : 'On iPad, add this page to your Home Screen so Safari keeps the data.'}` }),
      h('div', { class: 'row-form' },
        h('button', { class: 'btn', type: 'button', text: 'Download encrypted backup', onclick: guard(msg, downloadBackup) }),
        h('button', { class: 'btn ghost', type: 'button', text: 'Lock now', onclick: guard(msg, async () => { closeSettings(); await lockNow(); }) })),
      h('details', { class: 'fine' }, h('summary', { text: 'Change passphrase' }),
        h('div', { class: 'row-form' },
          h('input', { id: 'sec-pass', type: 'password', autocomplete: 'new-password', placeholder: 'New passphrase', 'aria-label': 'New passphrase' }),
          h('input', { id: 'sec-pass2', type: 'password', autocomplete: 'new-password', placeholder: 'Type it again', 'aria-label': 'Repeat passphrase' }),
          h('button', { class: 'btn ghost', type: 'button', text: 'Change', onclick: guard(msg, async () => {
            await setPassphrase($('sec-pass').value, $('sec-pass2').value);
            msg.textContent = 'Passphrase changed.'; $('sec-pass').value = ''; $('sec-pass2').value = '';
          }) }))));
  }

  if (!PREVIEW && !state.demo) {
    kids.push(h('details', { class: 'fine' }, h('summary', { text: 'Restore from a backup file' }),
      h('div', { style: 'display:flex;flex-direction:column;gap:8px;padding-top:6px' },
        h('p', { class: 'note', text: 'This replaces what is on this device with the backup, and uses the backup’s passphrase from now on.' }),
        h('div', { class: 'row-form' },
          h('input', { id: 'restore-file', type: 'file', accept: '.json,application/json', 'aria-label': 'Backup file' }),
          h('input', { id: 'restore-pass', type: 'password', placeholder: "Backup's passphrase", 'aria-label': 'Backup passphrase' }),
          twoStep('Restore', state.raw.length ? 'Tap again to replace this device’s data' : 'Tap again to restore',
            guard(msg, async () => { await restoreFrom($('restore-file').files[0], $('restore-pass').value); }), 'btn ghost')))));
  }

  if (!state.demo) {
    kids.push(h('h3', { class: 'set-h', text: 'Remove data' }),
      h('div', { class: 'row-form' },
        twoStep('Remove all statements', 'Tap again to remove', guard(msg, async () => {
          state.raw = []; state.overrides = {}; recompute(); render(); markDirty(); msg.textContent = 'Statements removed. Your plan and trips are kept.';
        })),
        !PREVIEW && twoStep('Erase everything on this device', 'Tap again to erase everything', guard(msg, eraseDevice))));
  }
  body.append(...kids, msg);
}

// ---------- start up ----------
$('lock-restore-btn').addEventListener('click', async () => {
  const msg = $('lock-msg');
  msg.className = 'msg'; msg.textContent = 'Restoring…';
  try { await restoreFrom($('lock-restore-file').files[0], $('lock-restore-pass').value); msg.textContent = ''; }
  catch (err) { msg.className = 'msg error'; msg.textContent = err.message; }
});
$('lock-erase-slot').append(twoStep('Erase everything on this device', 'Tap again to erase everything', async () => {
  try { await eraseDevice(); } catch (err) { $('lock-msg').className = 'msg error'; $('lock-msg').textContent = err.message; }
}));

async function boot() {
  $('hostnote').hidden = !isTestAddress(globalThis.location?.hostname ?? '');
  let env = null;
  if (!PREVIEW) {
    try { env = await storage.load(); }
    catch { $('status').textContent = `${STORAGE_MSG} You can still use the app, but nothing will be kept.`; }
  }
  if (env && readDemoFlag()) {
    // Dummy numbers were on when the page closed: ask for the passphrase like any other opening, then go back to them.
    state.envelope = env; state.demo = true; state.locked = true;
  } else if (env) {
    state.envelope = env; state.locked = true;
    writeDemoFlag(false);
  } else {
    writeDemoFlag(false);
  }
  recompute();
  render();
}
boot();
