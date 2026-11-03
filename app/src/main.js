import { parseStatement, toCents } from './parsers.js';
import { withIds, mergeTransactions } from './ledger.js';
import { matchTransfers } from './transfers.js';
import { categorize } from './rules.js';
import { CATEGORIES, codeLabel, sourceLabel, applyTripNames, selectableCategories, applyCoding, setCode, cleanCoding, codingList, MAX_TRIPS } from './categories.js';
import { weekSummary, weeklyRunning, monthSummary, startOfWeek, addDays, daysBetween, monthOf, plannedFreeCash, validatePlan } from './budget.js';
import { asOfDate, categoryBreakdown, monthPace, topPurchases, diningOut, habits, attention, coverage, monthlyMatrix } from './insights.js';
import { assignTrips, addTrip, removeTrip } from './trips.js';
import { trialBalance, tieOut, openingAccounts, cleanOpening, countBeforeOpening, DEFAULT_OPENING_DATE } from './journal.js';
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
  raw: [], overrides: {}, trips: [], coding: {},
  txs: [], ym: null, year: null, tab: 'budget', returnTab: null,
  gl: { cat: '', ym: '', q: '', week: '', ask: false, acct: '' },
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
  applyCoding(state.coding);
  applyTripNames(state.trips);
  const auto = assignTrips(categorize(matchTransfers(state.raw)), state.trips);
  state.txs = auto.map(t => {
    const pick = state.overrides[t.id];
    return pick && CATEGORIES[pick] ? { ...t, category: pick, categoryReason: 'your choice', chosen: true } : t;
  }).sort((a, b) => a.date.localeCompare(b.date));
  const months = [...new Set(state.txs.map(t => monthOf(t.date)))].sort();
  if (!months.includes(state.ym)) state.ym = months[months.length - 1] ?? null;
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
const snapshot = () => ({ version: 1, raw: state.raw, overrides: state.overrides, trips: state.trips, plan, coding: state.coding, opening: state.opening });

function loadSnapshot(d) {
  state.raw = Array.isArray(d.raw) ? d.raw : [];
  state.overrides = d.overrides && typeof d.overrides === 'object' ? d.overrides : {};
  state.trips = Array.isArray(d.trips) ? d.trips : [];
  state.coding = cleanCoding(d.coding);
  state.opening = cleanOpening(d.opening);
  try { validatePlan(d.plan); plan = d.plan; } catch { plan = samplePlan; }
}

function clearMemory() {
  state.raw = []; state.overrides = {}; state.trips = []; state.coding = {}; state.opening = { date: DEFAULT_OPENING_DATE, balances: {} }; state.txs = [];
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
    loadSnapshot(data);
    state.vault = vault; state.locked = false; state.save = 'saved'; state.tab = 'budget';
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
const emptyGl = () => ({ cat: '', ym: '', q: '', week: '', ask: false, acct: '' });
const resetGl = () => { state.gl = emptyGl(); };

function drill(filter) {
  const gl = emptyGl();
  if (filter.type === 'category') { gl.cat = filter.id; gl.ym = filter.ym ?? ''; }
  else if (filter.type === 'source') { gl.acct = filter.account; gl.ym = filter.ym ?? ''; }
  else if (filter.type === 'week') gl.week = filter.start;
  else if (filter.type === 'ask') gl.ask = true;
  state.gl = gl;
  if (state.tab !== 'gl') state.returnTab = state.tab;
  setTab('gl');
  window.scrollTo({ top: 0 });
}

const glActive = () => { const g = state.gl; return !!(g.cat || g.acct || g.ym || g.q.trim() || g.week || g.ask); };

function visibleTxs() {
  const g = state.gl;
  let list = state.txs;
  if (g.cat) list = list.filter(t => t.category === g.cat);
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
    state.gl.acct && chip(`Account: ${sourceLabel(state.gl.acct)}`, () => { state.gl.acct = ''; renderGlRows(); }),
    state.gl.week && chip(`Week of ${fmtDate(state.gl.week)}`, () => { state.gl.week = ''; renderGlRows(); }),
    state.gl.ask && chip('Big dinners and drinks to ask about', () => { state.gl.ask = false; renderGlRows(); }),
    glActive() && h('button', { type: 'button', class: 'linkbtn', text: 'Clear all filters', onclick: () => { resetGl(); renderGlControls(); renderGlRows(); } }));
  const back = $('gl-back');
  back.hidden = !state.returnTab;
  if (state.returnTab) back.textContent = `← Back to ${TAB_LABELS[state.returnTab]}`;

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

// ---------- sections ----------
function renderHero(asOf) {
  const weekStart = startOfWeek(asOf);
  const wk = weekSummary(state.txs, plan, weekStart);
  const day = daysBetween(weekStart, asOf) + 1;
  const left = wk.target - wk.spent;
  const pct = wk.target > 0 ? Math.min(100, Math.max(0, wk.spent / wk.target * 100)) : 100;
  const paceDiff = Math.round(wk.target * day / 7) - wk.spent;
  const over = left < 0;
  fill($('hero'),
    h('div', { class: 'card-head' },
      h('h2', { id: 'hero-title', text: 'This week' }),
      h('span', { class: 'sub', text: `${fmtDate(weekStart)} to ${fmtDate(addDays(weekStart, 6))} · day ${day} of 7` })),
    h('div', { class: 'hero-num' }, money(left), h('small', { text: over ? 'over' : 'left to spend' })),
    h('div', { class: 'meter' + (over ? ' over' : ''), role: 'img', 'aria-label': `Spent ${money(wk.spent)} of ${money(wk.target)}` },
      h('div', { class: 'fill', style: `width:${pct}%` }),
      h('div', { class: 'tick', style: `left:${day / 7 * 100}%` })),
    h('div', { class: 'legend-row' },
      h('span', { text: `Spent ${money(wk.spent)} of your ${money(wk.target)} weekly free cash` }),
      h('span', { class: 'key' }, h('i', { class: 'tick' }), 'Even pace for today'),
      h('button', { type: 'button', class: 'linkbtn', style: 'padding:0', text: 'Edit plan', onclick: openPlan })),
    h('p', { text: paceDiff >= 0
      ? `You're ${money(paceDiff)} under pace so far. Whatever you don't spend goes to savings.`
      : `You're ${money(paceDiff)} over pace so far. It comes out of savings unless the rest of the week runs lighter.` }));
}

function barPath(x, y0, y1, w, r) {
  const rad = Math.min(r, Math.abs(y1 - y0), w / 2);
  const up = y1 < y0;
  return up
    ? `M${x},${y0} V${y1 + rad} Q${x},${y1} ${x + rad},${y1} H${x + w - rad} Q${x + w},${y1} ${x + w},${y1 + rad} V${y0} Z`
    : `M${x},${y0} V${y1 - rad} Q${x},${y1} ${x + rad},${y1} H${x + w - rad} Q${x + w},${y1} ${x + w},${y1 - rad} V${y0} Z`;
}

function weeklyChart(rows) {
  const measured = $('trend').clientWidth - 38; // card width minus its padding and border
  const W = measured > 200 ? Math.round(measured) : 640, H = 216, padL = 8, padR = 8, padT = 24, padB = 44;
  const plotH = H - padT - padB;
  const max = Math.max(0, ...rows.map(r => r.effect));
  const min = Math.min(0, ...rows.map(r => r.effect));
  const span = max - min || 1;
  const y = v => padT + (max - v) / span * plotH;
  const slot = (W - padL - padR) / rows.length;
  const bw = Math.min(24, slot * 0.6);
  const labelIdx = new Set([rows.length - 1]);
  let best = 0, worst = 0;
  rows.forEach((r, i) => { if (r.effect > rows[best].effect) best = i; if (r.effect < rows[worst].effect) worst = i; });
  labelIdx.add(best); labelIdx.add(worst);
  const everyOther = rows.length > 8;

  const wrap = h('div', { class: 'chart-wrap' });
  const tip = h('div', { class: 'tip', hidden: true, role: 'presentation' });
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Effect on savings by week' });
  svg.append(s('line', { class: 'zero', x1: padL, x2: W - padR, y1: y(0), y2: y(0) }));

  rows.forEach((r, i) => {
    const cx = padL + slot * i + slot / 2;
    const x = cx - bw / 2;
    const neg = r.effect < 0;
    const inProgress = r.partial && i === rows.length - 1;
    const label = `Week of ${fmtDate(r.weekStart)}${inProgress ? ' (so far)' : ''}: ${signed(r.effect)}`;
    const show = () => {
      const bar = g.querySelector('.bar').getBoundingClientRect(), box = wrap.getBoundingClientRect();
      fill(tip, h('b', { text: signed(r.effect) }),
        h('span', { text: `Week of ${fmtDate(r.weekStart)}${inProgress ? ` · ${r.days} days so far` : r.partial ? ` · ${r.days} days of data` : ''}` }), h('br'),
        h('span', { text: `Spent ${money(r.spent)} of ${money(r.target)}` }));
      tip.hidden = false;
      tip.style.left = `${Math.min(Math.max(bar.left + bar.width / 2 - box.left, 90), box.width - 90)}px`;
      tip.style.top = `${bar.top - box.top - 8}px`;
    };
    const g = s('g', {
      class: 'hit', tabindex: 0, role: 'button', 'aria-label': `${label}. Show these transactions.`,
      onpointerenter: show, onpointerleave: () => { tip.hidden = true; }, onfocus: show, onblur: () => { tip.hidden = true; },
      onclick: () => drill({ type: 'week', start: r.weekStart }),
      onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drill({ type: 'week', start: r.weekStart }); } },
    },
      s('rect', { x: cx - slot / 2, y: 0, width: slot, height: H - padB + 16, fill: 'transparent' }),
      s('path', { class: 'bar' + (neg ? ' neg' : '') + (inProgress ? ' partial' : ''), d: barPath(x, y(0), y(r.effect), bw, 4) }),
      s('rect', { class: 'focus-ring', x: cx - slot / 2 + 1, y: 1, width: slot - 2, height: H - padB + 14, rx: 6 }));
    svg.append(g);
    if (labelIdx.has(i)) {
      svg.append(s('text', { class: 'val', x: cx, y: neg ? y(r.effect) + 15 : y(r.effect) - 7, 'text-anchor': 'middle', text: signed(r.effect) }));
    }
    if (!everyOther || i % 2 === rows.length % 2 || i === rows.length - 1) {
      svg.append(s('text', { x: cx, y: H - 8, 'text-anchor': 'middle', text: fmtDate(r.weekStart) }));
    }
  });
  wrap.append(svg, tip);
  return wrap;
}

// ---------- trial balance and income statement (TB Summary tab) ----------
const TB_VIEWS = [['bal', 'Balances'], ['act', 'Activity'], ['is', 'Income statement']];
const viewToggle = asOf => h('div', { class: 'seg', role: 'group', 'aria-label': 'View' },
  TB_VIEWS.map(([id, label]) => h('button', { type: 'button', text: label, 'aria-pressed': String(state.tbView === id), onclick: () => { state.tbView = id; renderTB(asOf, false); } })));

function renderTB(asOf, keepFocus) {
  if (state.tbView === 'is') renderMatrix(asOf, keepFocus); else renderTrialBalance(asOf, keepFocus);
}

// Where a trial-balance number leads in GL Detail.
function drillFor(row, ym) {
  if (row.key === 'clearing' || row.key === 'equity' || row.key === 'retained') return null;
  if (row.key.startsWith('src:')) return { type: 'source', account: row.key.slice(4), ym };
  return { type: 'category', id: row.key, ym };
}

const fmtFull = iso => dateOf(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function renderTrialBalance(asOf, keepFocus) {
  const bal = state.tbView === 'bal';
  const years = [...new Set(state.txs.map(t => t.date.slice(0, 4)))].sort().reverse();
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
  const select = h('select', { id: 'year', 'aria-label': 'Year', onchange: e => { state.year = e.target.value; renderTB(asOf, true); } },
    years.map(y => h('option', { value: y, text: y, selected: y === state.year })));
  fill($('matrix'),
    h('div', { class: 'card-head' }, h('h2', { id: 'matrix-title', text: bal ? 'Trial balance, month end' : 'Trial balance, monthly activity' }), h('div', { class: 'row-form' }, viewToggle(asOf), select)),
    h('p', { class: 'sub', text: bal
      ? `Accounts in number order. Each column is where the account stands at month end, starting from ${fmtFull(tb.openDate)}. Debits are plain numbers, credits in brackets. Income and spending start again each January; last year’s result moves to retained earnings. Whole dollars.`
      : 'Accounts in number order. Each column is that month’s movement: debits as plain numbers, credits in brackets. Whole dollars. Savings accounts show only what you moved in or out, since their own statements aren’t imported.' }),
    !tb.hasOpening && h('div', { class: 'notice' }, h('span', { text: 'No opening balances yet, so balances start from zero. Enter what each account held on your opening date to tie to your statements.' }),
      h('button', { class: 'btn', type: 'button', text: 'Enter opening balances', onclick: () => openSettings('opening') })),
    before > 0 && h('p', { class: 'note', text: `${plural(before, 'transaction', 'transactions')} dated on or before ${fmtFull(state.opening.date)} ${before === 1 ? 'is' : 'are'} before the books start and ${before === 1 ? 'isn’t' : 'aren’t'} in this view.` }),
    h('div', { class: 'mx-wrap' }, h('table', { class: 'mx' }, h('thead', {}, head), body)),
    h('div', { class: 'mx-legend' },
      h('span', { class: balanced ? 'ok' : 'bad', text: balanced ? '✓ Every month balances: debits equal credits' : '✗ Out of balance: see the Difference row' }),
      h('span', { text: 'Tap a number to see that month’s transactions. Scroll sideways for more months.' })));
  if (keepFocus) $('year').focus();
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

function renderTrend() {
  const all = weeklyRunning(state.txs, plan);
  const total = all[all.length - 1].running;
  const rows = all.slice(-12);
  fill($('trend'),
    h('div', { class: 'card-head' },
      h('h2', { id: 'trend-title', text: 'Effect on savings' }),
      h('span', { class: 'sub', text: `since ${fmtDate(all[0].from ?? state.txs[0].date)}` })),
    h('div', { style: 'font-size:32px;font-weight:700;letter-spacing:-0.02em', text: signed(total) }),
    h('p', { class: 'sub', text: total >= 0
      ? 'Your spending has been adding to savings. Each bar is a week against its target.'
      : 'Your spending has been pulling from savings. Each bar is a week against its target.' }),
    weeklyChart(rows),
    h('div', { class: 'legend-row' },
      h('span', { class: 'key' }, h('i'), 'Added to savings'),
      h('span', { class: 'key' }, h('i', { class: 'red' }), 'Pulled from savings'),
      rows[rows.length - 1].partial && h('span', { text: 'Faded bar: week still in progress' })));
}

function renderMonth(asOf, keepFocus) {
  const months = [...new Set(state.txs.map(t => monthOf(t.date)))].sort().reverse();
  const p = monthPace(state.txs, plan, state.ym, asOf);
  const m = monthSummary(state.txs, plan, state.ym);
  const over = p.left < 0;
  const pct = p.free > 0 ? Math.min(100, Math.max(0, p.spent / p.free * 100)) : 100;
  const select = h('select', { id: 'month', 'aria-label': 'Month', onchange: e => { state.ym = e.target.value; renderAfterMonth(true); } },
    months.map(ym => h('option', { value: ym, text: fmtMonth(ym), selected: ym === state.ym })));
  let pace;
  if (p.complete) pace = `Finished the month ${money(p.free - p.spent)} ${p.left >= 0 ? 'ahead of' : 'over'} plan.`;
  else if (p.elapsed >= 7) pace = `At this pace you'd finish about ${money(p.projectedEffect)} ${p.projectedEffect >= 0 ? 'ahead' : 'over'}.`;
  else pace = 'Too early to project. Check back after the first week.';
  const row = (label, g) => [h('span', { text: label }), h('span', { text: `${money(g.actual)} of ${money(g.planned)}` })];
  fill($('monthcard'),
    h('div', { class: 'card-head' }, h('h2', { id: 'month-title', text: 'This month' }), select),
    h('div', { style: 'font-size:28px;font-weight:700;letter-spacing:-0.02em' }, money(Math.abs(p.left)),
      h('small', { style: 'font-size:16px;font-weight:600;color:var(--ink-2);margin-left:6px', text: over ? 'over free cash' : 'free cash left' })),
    h('div', { class: 'meter' + (over ? ' over' : ''), role: 'img', 'aria-label': `Spent ${money(p.spent)} of ${money(p.free)}` },
      h('div', { class: 'fill', style: `width:${pct}%` })),
    h('p', { class: 'sub', text: `Spent ${money(p.spent)} of ${money(p.free)} free cash. ${pace}` }),
    h('div', { class: 'plan-rows' },
      row('Paycheck', m.income), row('Fixed bills', m.fixed), row('Subscriptions', m.subscriptions),
      row('One-time & annual set-aside', m.onetime),
      (m.vacation.planned > 0 || m.vacation.actual > 0) && row('Vacation set-aside', m.vacation),
      row('Savings moved', m.savings)));
  if (keepFocus) $('month').focus();
}

function renderWhere() {
  const b = categoryBreakdown(state.txs, state.ym);
  const top = b.rows[0]?.cents ?? 1;
  fill($('where'),
    h('div', { class: 'card-head' },
      h('h2', { id: 'where-title', text: 'Where the free cash went' }),
      h('span', { class: 'sub', text: `${fmtMonth(state.ym)} · ${money(b.total)}` })),
    b.rows.length
      ? h('div', { class: 'cats' }, b.rows.map(r =>
          h('button', { type: 'button', class: 'catrow', 'aria-label': `${r.name}: ${money(r.cents)}. Show these transactions.`,
            onclick: () => drill({ type: 'category', id: r.id, ym: state.ym }) },
            h('span', { class: 'catname', text: r.name }),
            h('span', { class: 'cattrack' },
              h('span', { class: 'catbar' + (r.id === 'review' ? ' review' : ''), style: `width:${Math.max(1, r.cents / top * 62)}%` }),
              h('span', { class: 'catval', text: `${money(r.cents)} · ${Math.round(r.share * 100)}%` })))))
      : h('p', { class: 'sub', text: 'No free-cash spending in this month yet.' }),
    b.rows.length && h('p', { class: 'note', text: 'Tap a row to see the transactions behind it.' }));
}

function renderHabits() {
  const rows = weeklyRunning(state.txs, plan);
  const hb = habits(rows);
  const m = monthSummary(state.txs, plan, state.ym);
  const dining = diningOut(state.txs, state.ym);
  const biggest = topPurchases(state.txs, state.ym, 1)[0];
  const att = attention(state.txs);
  const link = (label, filter) => h('button', { type: 'button', text: label, onclick: () => drill(filter) });

  const good = [], watch = [];
  if (hb.under > 0) good.push(h('li', { text: `${hb.under} of ${plural(hb.weeks, 'week', 'weeks')} came in under target.` }));
  if (hb.streak >= 2) good.push(h('li', { text: `${hb.streak} weeks in a row under target.` }));
  if (hb.best && hb.best.effect > 0) good.push(h('li', {}, `Best week: ${fmtDate(hb.best.weekStart)}, ${money(hb.best.effect)} added to savings.`, link('See it', { type: 'week', start: hb.best.weekStart })));
  if (m.subscriptions.planned > 0 && m.subscriptions.actual > 0 && m.subscriptions.actual <= m.subscriptions.planned) {
    good.push(h('li', { text: `Subscriptions are on plan (${money(m.subscriptions.actual)} of ${money(m.subscriptions.planned)}).` }));
  }
  if (hb.over > 0) watch.push(h('li', { text: `${hb.over} of ${plural(hb.weeks, 'week', 'weeks')} ran over target.` }));
  if (hb.worst && hb.worst.effect < 0) watch.push(h('li', {}, `Roughest week: ${fmtDate(hb.worst.weekStart)}, ${money(hb.worst.effect)} pulled from savings.`, link('See it', { type: 'week', start: hb.worst.weekStart })));
  if (dining.cents > 0 && dining.share >= 0.35) watch.push(h('li', { text: `Restaurants, coffee and bars are ${Math.round(dining.share * 100)}% of free spending (${money(dining.cents)}).` }));
  if (biggest) watch.push(h('li', { text: `Biggest purchase in ${fmtMonth(state.ym).split(' ')[0]}: ${money(biggest.cents)} at ${biggest.description}.` }));
  if (att.review.count) watch.push(h('li', {}, `${plural(att.review.count, 'charge', 'charges')} (${money(att.review.cents)}) still need a category. They count against free cash until then.`, link('Review', { type: 'category', id: 'review' })));
  if (att.reimbursements.length) watch.push(h('li', {}, `Expecting to be paid back for ${plural(att.reimbursements.length, 'big dinner or drinks charge', 'big dinner or drinks charges')}?`, link('See them', { type: 'ask' })));

  const card = (cls, title, items) => h('div', { class: `habit-card ${cls}` },
    h('h2', { text: title }),
    items.length ? h('ul', {}, items) : h('p', { class: 'none', text: 'Nothing here yet.' }));
  fill($('habits'), card('good', 'Going well', good), card('watch', 'Worth a look', watch));
}

// ---------- month-by-month table ----------
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const whole = c => {
  const n = Math.round(Math.abs(c) / 100);
  if (n === 0) return '\u2013';
  const txt = n.toLocaleString('en-US');
  return c < 0 ? `(${txt})` : txt;
};

function renderMatrix(asOf, keepFocus) {
  const years = [...new Set(state.txs.map(t => t.date.slice(0, 4)))].sort().reverse();
  const m = monthlyMatrix(state.txs, state.year, asOf);
  const isPartial = ym => ym === m.partialMonth;

  const head = h('tr', {}, h('th', { class: 'acct', style: 'text-align:left', text: 'GL account' }),
    m.months.map((ym, i) => h('th', {}, MONTH_ABBR[i], isPartial(ym) && h('small', { text: `to the ${Number(asOf.slice(8))}th` }))),
    h('th', { class: 'avg' }, 'Avg / mo', h('small', { text: 'full months' })),
    h('th', { class: 'total' }, 'Year to date'));

  const body = h('tbody');
  for (const l of m.lines) {
    if (l.kind === 'header') {
      body.append(h('tr', { class: 'hdr' }, h('td', { class: 'acct', text: l.code ? `${l.code}  ${l.label}` : l.label }), h('td', { colspan: 14 })));
      continue;
    }
    const cls = { row: '', subtotal: 'tot', net: 'net', running: 'run' }[l.kind];
    const tr = h('tr', { class: cls }, h('td', { class: 'acct' }, l.code && h('span', { class: 'code', text: l.code }), l.name ?? l.label));
    m.months.forEach(ym => {
      const v = l.byMonth[ym];
      if (v === null || (!m.hasData[ym])) { tr.append(h('td', { class: 'empty', text: '\u00b7' })); return; }
      let tone = '';
      if (l.kind === 'row' && l.group !== 'income' && m.fullMonthCount >= 3 && !isPartial(ym) && l.avg > 0) {
        const off = v - l.avg;
        if (Math.abs(off) >= Math.max(5000, l.avg * 0.25)) tone = off > 0 ? 'hi' : 'lo';
      }
      const td = h('td', { class: tone });
      if (l.kind === 'row' && v !== 0) {
        td.append(h('button', { type: 'button', class: 'cell', text: whole(v), 'aria-label': `${l.name}, ${MONTH_ABBR[Number(ym.slice(5)) - 1]}: ${money(v)}. Show these transactions.`,
          onclick: () => drill({ type: 'category', id: l.id, ym }) }));
      } else td.textContent = whole(v);
      tr.append(td);
    });
    if (l.kind === 'running') { tr.append(h('td', { class: 'avg' }), h('td', { class: 'total' })); }
    else { tr.append(h('td', { class: 'avg', text: whole(l.avg) }), h('td', { class: 'total', text: whole(l.total) })); }
    body.append(tr);
  }

  const select = h('select', { id: 'year', 'aria-label': 'Year', onchange: e => { state.year = e.target.value; renderTB(asOf, true); } },
    years.map(y => h('option', { value: y, text: y, selected: y === state.year })));
  fill($('matrix'),
    h('div', { class: 'card-head' }, h('h2', { id: 'matrix-title', text: 'Income statement by month' }), h('div', { class: 'row-form' }, viewToggle(asOf), select)),
    h('p', { class: 'sub', text: 'Whole dollars. Down to Net operating income, money spent shows as a positive number. Below it, brackets reduce net income, so each total adds up. Transfers between your own accounts are left out.' }),
    h('div', { class: 'mx-wrap' }, h('table', { class: 'mx' }, h('thead', {}, head), body)),
    h('div', { class: 'mx-legend' },
      m.fullMonthCount >= 3 && h('span', {}, h('i', { style: 'background:var(--tint-watch)' }), 'Well above that line\u2019s monthly average'),
      m.fullMonthCount >= 3 && h('span', {}, h('i', { style: 'background:var(--tint-good)' }), 'Well below it'),
      h('span', { text: 'Tap a number to see its transactions. Scroll sideways for more months.' })));
  if (keepFocus) $('year').focus();
}

// ---------- tabs and the main render ----------
const TABS = ['summary', 'budget', 'investments', 'savings', 'tb', 'tie', 'gl'];
const TAB_LABELS = { summary: 'Summary', budget: 'Budget', investments: 'Investments', savings: 'Savings', tb: 'TB Summary', tie: 'Tie-out', gl: 'GL Detail' };
const NEEDS_DATA = new Set(['budget', 'tb', 'tie', 'gl']); // the other tabs are placeholders for now

function applyTab() {
  const has = state.txs.length > 0;
  for (const name of TABS) {
    $(`tab-${name}`).setAttribute('aria-selected', String(state.tab === name));
    $(`panel-${name}`).hidden = state.tab !== name || (NEEDS_DATA.has(name) && !has);
  }
  $('empty').hidden = has || !NEEDS_DATA.has(state.tab);
}

function setTab(tab) {
  state.tab = tab;
  if (tab !== 'gl') state.returnTab = null;
  if (tab === 'gl' && state.txs.length) renderLedger();
  applyTab();
}
for (const name of TABS) $(`tab-${name}`).addEventListener('click', () => setTab(name));
$('gl-back').addEventListener('click', () => { const back = state.returnTab; state.returnTab = null; setTab(back ?? 'budget'); });
$('empty-settings').addEventListener('click', () => openSettings('saving'));
$('banner-btn').addEventListener('click', () => { openSettings('saving'); $('sec-pass')?.focus(); });

function renderAfterMonth(keepFocus) {
  const asOf = asOfDate(state.txs);
  renderMonth(asOf, keepFocus);
  renderWhere();
  renderHabits();
  renderLedger();
}

function render() {
  renderSaveState();
  $('lock').hidden = !state.locked;
  $('app').hidden = state.locked;
  $('add-btn').hidden = state.locked || state.demo;
  if (state.locked) {
    for (const id of ['hero', 'trend', 'monthcard', 'where', 'habits', 'matrix', 'plan-body', 'chips', 'gl-controls', 'coverage']) $(id).replaceChildren();
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
    renderHero(asOf);
    renderTrend();
    renderAfterMonth(false);
    renderTB(asOf, false);
    renderTie();
  }
  if (!document.activeElement?.closest('#plan-body')) renderPlan();   // don't rebuild the form while you type in it
  updatePlanSummary();
  applyTab();
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.txs.length && !state.locked) renderTrend(); }, 150);
});

// ---------- your plan (inside the Budget tab, collapsed) ----------
const dollars = c => (c / 100).toFixed(2).replace(/\.00$/, '');
const guard = (msgEl, fn) => async (...args) => {
  msgEl.className = 'msg'; msgEl.textContent = '';
  try { await fn(...args); } catch (err) { msgEl.className = 'msg error'; msgEl.textContent = err.message; }
};

function planFieldDefs() {
  const idsIn = g => Object.values(CATEGORIES).filter(c => c.group === g).sort((a, b) => a.code.localeCompare(b.code));
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

function renderCodingScreen(body) {
  const msg = h('p', { class: 'msg', role: 'status' });
  const change = (key, value, input) => {
    try {
      state.coding = setCode(state.coding, key, value);
      applyCoding(state.coding);
      recompute(); render(); markDirty();
      renderSettingsScreen();
      document.getElementById(`code-${key}`)?.focus();
    } catch (err) {
      input.value = codingList(state.trips, state.coding).find(r => r.key === key).code;
      input.classList.add('bad');
      msg.className = 'msg error'; msg.textContent = err.message;
    }
  };
  const list = codingList(state.trips, state.coding);
  const rows = [];
  for (const cls of [...new Set(list.map(r => r.class))]) {
    rows.push(h('h3', { class: 'set-h', text: cls }));
    for (const r of list.filter(x => x.class === cls)) {
      rows.push(h('div', { class: 'code-row' },
        r.editable
          ? h('input', { id: `code-${r.key}`, type: 'text', inputmode: 'numeric', maxlength: '4', value: r.code, class: r.changed ? 'changed' : '',
              'aria-label': `TB number for ${r.name}`, onchange: e => change(r.key, e.target.value, e.target) })
          : h('span', { class: 'code fixed', text: r.code }),
        h('span', { text: r.name }),
        h('span', { class: 'coa-status' + (r.status === 'Planned' ? ' planned' : ''), text: r.changed ? 'Changed' : r.status })));
    }
  }
  body.append(
    h('p', { class: 'sub', text: 'Each account has a TB number. Change one and every screen follows, including the order of the TB Summary. Numbers are 4 digits and each is used once. Planned accounts are reserved for later phases.' }),
    msg, h('div', {}, rows),
    h('div', { class: 'row-form', style: 'margin-top:12px' },
      twoStep('Reset all numbers to the defaults', 'Tap again to reset', () => {
        state.coding = {}; applyCoding({}); recompute(); render(); markDirty(); renderSettingsScreen();
      })));
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
    // Dummy numbers were on when the page closed: reopen on them, without asking for the passphrase.
    state.envelope = env; state.demo = true;
    loadSnapshot(dummySnapshot());
    $('status').textContent = 'Showing dummy numbers. Your own data is not on screen.';
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
