import { parseStatement, toCents } from './parsers.js';
import { withIds, mergeTransactions } from './ledger.js';
import { matchTransfers } from './transfers.js';
import { categorize } from './rules.js';
import { nestRows, addMaps } from './nesting.js';
import { glExport, chartExport, toCsv, exportFileName, NAME_MODES } from './glexport.js';
import { applyFuelSplit, cleanFuel, DEFAULT_FUEL } from './fuel.js';
import { filterItems, applyBulk, undoBulk, similarTo, rangeBetween, learn, forget, applyLearned, cleanLearned, merchantKey } from './bulk.js';
import { parseAccess, checkCode, fingerprint, ACCESS_FLAG } from './gate.js';
import { createSyncClient, newSyncKeys, cleanKeys, pairingCode, parsePairingCode, planSync, SYNC_ORIGIN } from './sync.js';
import { CATEGORIES, SOURCE_ACCOUNTS, codeLabel, sourceLabel, applyTripNames, selectableCategories, applyCoding, setCode, cleanCoding, codingList, applyNames, setName, cleanNames, applyCustoms, cleanCustoms, addAccount, ADD_KINDS, moveAccount, cleanParents, applyParents, depthOf, headersAbove, organizeAssets, SECTIONS, removeSub, setMatch, customRules, applyRemoved, cleanRemoved, removeAccount, restoreAccount, removeTargets, removedList, resolveCategory, isRemoved, migrateCategory, MAX_TRIPS } from './categories.js';
import { weekSummary, weeklyRunning, monthSummary, startOfWeek, addDays, daysBetween, monthOf, plannedFreeCash, validatePlan } from './budget.js';
import { asOfDate, monthPace, habits, attention, coverage, monthlyMatrix, completeWeeks, periodWindow, periodTotals, compareTotals, cumulativeSeries, categoryBreakdownRange, topPurchasesRange, diningOutRange, staleAccounts, defaultMonth } from './insights.js';
import { assignTrips, addTrip, removeTrip, updateTrip } from './trips.js';
import { trialBalance, balanceSheet, tieOut, openingAccounts, cleanOpening, countBeforeOpening, DEFAULT_OPENING_DATE } from './journal.js';
import { createVault, seal, unlock, openWith } from './vault.js';
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
  raw: [], overrides: {}, trips: [], coding: {}, names: {}, customs: [], parents: {}, removed: {}, learned: {}, fuel: { ...DEFAULT_FUEL }, sync: null,
  txs: [], ym: null, year: null, month: '', tab: 'budget', fsPage: 'tb', returnTo: null, period: '4w', exp: { from: '', to: '', names: 'merchant', open: false }, bulk: { sel: new Set(), view: 'review', q: '', ym: '', limit: 150, last: null, undo: null, note: '' },
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
  state.parents = cleanParents(state.parents);
  applyParents(state.parents);
  applyCoding(state.coding);
  applyTripNames(state.trips);
  const auto = assignTrips(applyLearned(applyFuelSplit(categorize(matchTransfers(state.raw), { userRules: customRules(state.customs) }), state.fuel), state.learned, id => !!CATEGORIES[id]), state.trips);
  state.txs = auto.map(t => {
    const pick = migrateCategory(state.overrides[t.id]);
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
  let added = 0, skipped = 0, external = 0;
  try {
    for (const file of files) {
      let parsed;
      try { parsed = parseStatement(await file.text()); }
      catch (err) { throw new Error(`${file.name}: ${err.message}`); }
      const r = mergeTransactions(state.raw, withIds(parsed.transactions));
      state.raw = r.merged; added += r.addedCount; skipped += r.skippedCount; external += parsed.notes?.external ?? 0;
    }
    $('status').textContent = `Added ${plural(added, 'transaction', 'transactions')}` +
      (skipped ? ` and skipped ${skipped} you already had` : '') + '. Nothing was uploaded.' +
      (external ? ` ${plural(external, 'Venmo payment', 'Venmo payments')} you funded from a bank or card ${external === 1 ? 'was' : 'were'} left out: ${external === 1 ? 'it is' : 'they are'} already on that statement.` : '');
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
const snapshot = () => ({ version: 1, raw: state.raw, overrides: state.overrides, trips: state.trips, plan, coding: state.coding, names: state.names, customs: state.customs, parents: state.parents, removed: state.removed, learned: state.learned, fuel: state.fuel, sync: state.sync, opening: state.opening });

function loadSnapshot(d) {
  state.raw = Array.isArray(d.raw) ? d.raw : [];
  state.overrides = d.overrides && typeof d.overrides === 'object' ? d.overrides : {};
  state.trips = Array.isArray(d.trips) ? d.trips : [];
  state.customs = cleanCustoms(d.customs);
  applyCustoms(state.customs);
  state.names = cleanNames(d.names);
  state.removed = cleanRemoved(d.removed);
  applyRemoved(state.removed);
  state.parents = cleanParents(d.parents);
  applyParents(state.parents);
  state.coding = cleanCoding(d.coding);
  state.learned = cleanLearned(Object.fromEntries(Object.entries(d.learned ?? {}).map(([k, r]) => [k, r && { ...r, c: migrateCategory(r.c) }])), id => !!CATEGORIES[id]);
  state.fuel = cleanFuel(d.fuel, id => !!CATEGORIES[migrateCategory(id)]);
  state.sync = cleanKeys(d.sync);
  state.opening = cleanOpening(d.opening);
  try { validatePlan(d.plan); plan = d.plan; } catch { plan = samplePlan; }
}

function clearMemory() {
  state.raw = []; state.overrides = {}; state.trips = []; state.coding = {}; state.names = {}; state.customs = []; state.removed = {}; applyRemoved({}); state.parents = {}; applyParents({}); state.sync = null; state.learned = {}; state.fuel = { ...DEFAULT_FUEL }; state.opening = { date: DEFAULT_OPENING_DATE, balances: {} }; state.txs = [];
  state.ym = null; state.year = null; resetGl();
  plan = samplePlan;
}

let saveTimer = null;
let saveChain = Promise.resolve();
function markDirty() {
  if (state.vault && !state.demo) {
    state.save = 'pending'; clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 300);
    if (state.sync) { editSeq++; lsSet(DIRTY_KEY, '1'); }      // changed since the last time devices were in step
  }
  renderSaveState();
}
function flushSave() {
  clearTimeout(saveTimer);
  if (!state.vault || state.demo || state.save !== 'pending') return saveChain;   // nothing changed, nothing to write
  saveChain = saveChain.then(async () => {
    try { await storage.save(await seal(state.vault, snapshot())); state.save = 'saved'; if (state.sync) syncSoon(); }
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
  else if (state.vault) text = { pending: 'Saving…', saved: 'Saved on this device', idle: 'Saved on this device', error: "Couldn't save. Download a backup." }[state.save] + syncChip();
  else if (state.raw.length) text = 'Not saved yet';
  const chip = $('savechip');
  chip.textContent = text;
  chip.hidden = !text;
  chip.className = 'savechip' + (state.demo ? ' demo' : state.save === 'error' || (!PREVIEW && !state.vault && state.raw.length) ? ' warn' : '');
  $('savebanner').hidden = PREVIEW || state.demo || !!state.vault || state.locked || !state.raw.length;
}

// ---------- sync between your devices ----------
// Your data is encrypted on this device and only that encrypted copy goes to your own sync server (see sync.js).
// This device remembers the revision it last synced and whether it has changed since; those two facts are not secret.
const REV_KEY = 'my-budget-sync-rev', DIRTY_KEY = 'my-budget-sync-dirty';
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable: sync just starts over next time */ } };
const baseRev = () => Number(lsGet(REV_KEY) ?? 0) || 0;
let editSeq = 0, syncTimer = null, syncRunning = null, lastSyncTry = 0;
const syncStatus = { busy: false, at: null, error: '', conflict: null, rollback: null };

const syncChip = () => {
  if (!state.sync) return '';
  if (syncStatus.busy) return ' · syncing…';
  if (syncStatus.conflict) return ' · needs your choice';
  if (syncStatus.error) return ' · sync problem';
  return syncStatus.at ? ' · synced' : '';
};
function renderSyncUi() {
  renderSaveState();
  renderSyncBanner();
  if (!$('settings').hidden && state.settingsScreen === 'sync') renderSettingsScreen();
}
const syncSoon = (ms = 1500) => { clearTimeout(syncTimer); syncTimer = setTimeout(() => { syncNow(); }, ms); };

function syncNow() {
  if (syncRunning) return syncRunning;
  syncRunning = runSync().finally(() => { syncRunning = null; syncStatus.busy = false; renderSyncUi(); });
  return syncRunning;
}

// Takes the other device's copy and makes it this device's data.
async function adoptRemote(remote) {
  const data = await openWith(state.vault, remote.envelope);         // throws if it was made with a different passphrase set-up
  const keep = state.sync;
  loadSnapshot(data);
  if (!state.sync) state.sync = keep;
  await storage.save(remote.envelope);
  state.save = 'saved';
  lsSet(REV_KEY, String(remote.rev)); lsSet(DIRTY_KEY, '0');
  recompute(); render();
}

async function pushLocal(client, ifMatch) {
  const seq = editSeq;
  const res = await client.push(state.sync.id, state.sync.token, ifMatch, await seal(state.vault, snapshot()));
  if (!res.ok) return false;                                         // someone saved first: look again
  lsSet(REV_KEY, String(res.rev));
  if (seq === editSeq) lsSet(DIRTY_KEY, '0'); else syncSoon();       // edits made while saving go next
  syncStatus.at = Date.now();
  return true;
}

async function runSync() {
  if (PREVIEW || !state.sync || !state.vault || state.demo || state.locked) return;
  const client = createSyncClient();
  syncStatus.busy = true; syncStatus.error = ''; renderSaveState();
  lastSyncTry = Date.now();
  try {
    await flushSave();
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await client.pull(state.sync.id, state.sync.token);
      const action = planSync({ baseRev: baseRev(), dirty: lsGet(DIRTY_KEY) === '1', remote });
      if (action === 'idle') { syncStatus.at = Date.now(); syncStatus.conflict = null; return; }
      if (action === 'pull') { await adoptRemote(remote); syncStatus.at = Date.now(); syncStatus.conflict = null; return; }
      if (action === 'conflict') { syncStatus.conflict = remote; return; }
      if (action === 'rollback') { syncStatus.rollback = remote; syncStatus.error = 'The sync server has an older copy than this device last saw.'; return; }
      if (await pushLocal(client, remote ? remote.rev : 0)) { syncStatus.conflict = null; return; }
    }
    syncStatus.error = 'Another device keeps saving at the same time. Try again in a moment.';
  } catch (err) {
    syncStatus.error = err.needsPassphrase ? 'The other copy was saved with a different passphrase set-up. Use “Join with a code” on this device.' : err.message;
  }
}

// Both devices changed: you choose which copy to keep. The server still holds its last few versions either way.
async function resolveConflict(keepThis) {
  const remote = syncStatus.conflict;
  if (!remote) return;
  syncStatus.busy = true; syncStatus.error = ''; renderSyncUi();
  try {
    if (keepThis) { if (!(await pushLocal(createSyncClient(), remote.rev))) { syncStatus.conflict = null; syncStatus.busy = false; return syncNow(); } }
    else await adoptRemote(remote);
    syncStatus.conflict = null; syncStatus.at = Date.now();
  } catch (err) { syncStatus.error = err.message; }
  syncStatus.busy = false; renderSyncUi();
}

async function enableSync() {
  if (!state.vault) throw new Error('Set a passphrase first (Saving & backup), so your data is encrypted before it leaves this device.');
  if (state.demo) throw new Error('Turn dummy numbers off first.');
  state.sync = newSyncKeys();
  lsSet(REV_KEY, '0'); lsSet(DIRTY_KEY, '1'); editSeq++;
  state.save = 'pending';
  await syncNow();
  if (syncStatus.error || !syncStatus.at) {
    const why = syncStatus.error || 'Couldn’t save to the sync server.';
    state.sync = null; lsSet(REV_KEY, null); lsSet(DIRTY_KEY, null); syncStatus.error = ''; syncStatus.at = null;
    state.save = 'pending'; await flushSave();
    throw new Error(why);
  }
  state.save = 'pending'; await flushSave();                          // keep the new keys on this device
}

function disableSync() {
  state.sync = null; lsSet(REV_KEY, null); lsSet(DIRTY_KEY, null);
  syncStatus.at = null; syncStatus.error = ''; syncStatus.conflict = null; syncStatus.rollback = null;
  state.save = 'pending'; markDirty();
}

async function deleteServerCopy() {
  const keys = state.sync;
  if (!keys) return;
  await createSyncClient().remove(keys.id, keys.token);
  disableSync();
}

// Pairs this device with the data another device already syncs, using that device's code and your passphrase.
async function joinSync(codeText, passphrase) {
  if (state.demo) throw new Error('Turn dummy numbers off first.');
  const keys = parsePairingCode(codeText);
  const remote = await createSyncClient().pull(keys.id, keys.token);
  if (!remote) throw new Error('The sync server has nothing for that code. Check it was copied from the device that turned sync on.');
  const { vault, data } = await unlock(remote.envelope, passphrase);   // throws on a wrong passphrase
  loadSnapshot(data);
  state.sync = keys;
  state.vault = vault; state.locked = false; state.envelope = null; state.demo = false;
  await storage.save(remote.envelope);
  state.save = 'saved'; state.tab = 'budget';
  lsSet(REV_KEY, String(remote.rev)); lsSet(DIRTY_KEY, '0');
  syncStatus.at = Date.now(); syncStatus.error = ''; syncStatus.conflict = null;
  syncNotice = 'Paired. This device now has your data and will stay in step.';
  state.persisted = await storage.requestPersistence();
  recompute(); render(); renderSettingsScreen();
}

function renderSyncBanner() {
  const el = $('syncbanner');
  const c = syncStatus.conflict, back = syncStatus.rollback;
  if (!state.sync || state.locked || state.demo || (!c && !back)) { el.hidden = true; el.replaceChildren(); return; }
  el.hidden = false;
  if (c) {
    el.replaceChildren(h('span', { text: 'Both of your devices changed since they last synced. Which copy do you want to keep? (The other is not deleted from the server straight away.)' }),
      h('span', { class: 'row-form' },
        h('button', { class: 'btn', type: 'button', id: 'keep-this', text: 'Keep this device’s', onclick: () => resolveConflict(true) }),
        h('button', { class: 'btn ghost', type: 'button', id: 'keep-other', text: 'Use the other device’s', onclick: () => resolveConflict(false) })));
  } else {
    el.replaceChildren(h('span', { text: 'The sync server has an older copy than this device last saw. That can mean it was restored from an old version. Your data on this device is unchanged.' }),
      h('span', { class: 'row-form' },
        h('button', { class: 'btn', type: 'button', text: 'Replace the server copy with this device’s', onclick: async () => {
          try { await pushLocal(createSyncClient(), back.rev); syncStatus.rollback = null; syncStatus.error = ''; } catch (err) { syncStatus.error = err.message; }
          renderSyncUi();
        } }),
        h('button', { class: 'btn ghost', type: 'button', text: 'Not now', onclick: () => { syncStatus.rollback = null; renderSyncUi(); } })));
  }
}

// Coming back to the app, check for changes from your other device.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.sync && !state.locked && Date.now() - lastSyncTry > 15000) syncSoon(300);
});

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
    if (state.sync) syncNow();
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
  if (state.sync) { lsSet(DIRTY_KEY, '1'); editSeq++; syncNow(); }       // a restored backup is a change: other devices are asked before it overwrites them
  state.persisted = await storage.requestPersistence();
  recompute(); render(); renderSettingsScreen();
}

async function eraseDevice() {
  await storage.clear();
  lsSet(REV_KEY, null); lsSet(DIRTY_KEY, null); syncStatus.at = null; syncStatus.error = ''; syncStatus.conflict = null; syncStatus.rollback = null;
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

// The account choices, in number order and grouped by section, with your own accounts and sub accounts in place.
function categoryOptions(selected) {
  const groups = new Map();
  for (const c of selectableCategories(state.trips)) {
    if (!groups.has(c.class)) groups.set(c.class, []);
    groups.get(c.class).push(c);
  }
  return [...groups].map(([cls, items]) => h('optgroup', { label: cls }, items.map(c => h('option', { value: c.id, text: '\u00a0\u00a0'.repeat(c.depth) + c.label, selected: c.id === selected }))));
}

// Swaps a row's category label for a picker. Your choice is remembered and beats the automatic one.
function openPicker(cell, t) {
  const select = h('select', { 'aria-label': `Category for ${t.description}`,
    onchange: e => {
      if (e.target.value === '__auto') delete state.overrides[t.id]; else state.overrides[t.id] = e.target.value;
      if (CATEGORIES[e.target.value]?.group !== 'vacation') state.learned = learn(state.learned, [t], e.target.value).next;   // remember the merchant
      recompute(); render(); markDirty();
    },
    onblur: () => renderGlRows() },
    h('option', { value: '__auto', text: 'Let the app decide' }),
    categoryOptions(t.category));
  cell.replaceChildren(select);
  select.focus();
}

// ---------- the Coding tab: pick many items, give them an account in one go ----------
function renderCoding() {
  const b = state.bulk, root = $('code-body');
  const everything = filterItems(state.txs, { view: 'all' });
  const left = state.txs.filter(t => t.category === 'review').length;
  const months = [...new Set(state.txs.map(t => monthOf(t.date)))].sort().reverse();
  const choose = h('select', { id: 'code-choose', 'aria-label': 'Account for the selected items' },
    h('option', { value: '', text: 'Choose an account…' }), h('option', { value: '__auto', text: 'Let the app decide' }), categoryOptions(null));
  const apply = h('button', { type: 'button', class: 'btn', id: 'code-apply', text: 'Apply', onclick: () => {
    const ids = [...b.sel].filter(id => state.txs.some(t => t.id === id));
    if (!ids.length || !choose.value) return;
    const picked = state.txs.filter(t => ids.includes(t.id));
    const before = new Map(state.txs.map(t => [t.id, t.category]));
    const out = applyBulk(state.overrides, ids, choose.value);
    state.overrides = out.next;
    // Teach the app: charges from these merchants, past and future, now file the same way (vacation accounts follow trip dates instead).
    const priorLearned = state.learned;
    const taught = CATEGORIES[choose.value]?.group === 'vacation' ? { next: state.learned, remembered: [], skipped: [] } : learn(state.learned, picked, choose.value);
    state.learned = taught.next;
    const label = choose.value === '__auto' ? 'the app’s own choice' : codeLabel(choose.value);
    recompute();
    const alsoMoved = state.txs.filter(t => !ids.includes(t.id) && before.get(t.id) !== t.category).length;
    const names = taught.remembered.slice(0, 3).join(', ') + (taught.remembered.length > 3 ? ` and ${taught.remembered.length - 3} more` : '');
    const extra = [
      choose.value === '__auto' ? (taught.next !== priorLearned && Object.keys(priorLearned).length !== Object.keys(taught.next).length ? 'I’ve forgotten those merchants.' : '')
        : taught.remembered.length ? `I’ll file future ${names} charges there too${alsoMoved ? `, and I moved ${plural(alsoMoved, 'other one', 'other ones')}` : ''}.` : '',
      taught.skipped.length ? `I didn’t remember ${taught.skipped.slice(0, 3).join(', ')}: that name covers many kinds of purchase.` : '',
    ].filter(Boolean).join(' ');
    b.undo = { previous: out.previous, learned: priorLearned, text: `${plural(ids.length, 'item', 'items')} coded as ${label}` };
    b.note = `${plural(ids.length, 'item', 'items')} coded as ${label}. ${extra}`.trim();
    b.sel.clear(); b.last = null;
    render(); markDirty();
  } });
  const undo = b.undo && h('button', { type: 'button', class: 'btn ghost', id: 'code-undo', text: 'Undo', onclick: () => {
    state.overrides = undoBulk(state.overrides, b.undo.previous);
    state.learned = b.undo.learned;                                                  // and forget what that taught
    b.note = `Undone: ${b.undo.text}.`; b.undo = null;
    recompute(); render(); markDirty();
  } });
  const bar = h('div', { class: 'code-bar', id: 'code-bar' }, h('div', { class: 'count', id: 'code-count' }), choose, apply,
    h('button', { type: 'button', class: 'btn ghost', id: 'code-clear', text: 'Clear', onclick: () => { b.sel.clear(); b.last = null; renderCodingRows(); } }));
  const head = h('table', { class: 'coding', id: 'code-table' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'pick' }, h('input', { type: 'checkbox', id: 'code-all', 'aria-label': 'Select everything shown', onchange: e => {
        const shown = currentCodingList().slice(0, b.limit).map(t => t.id);
        for (const id of shown) { if (e.target.checked) b.sel.add(id); else b.sel.delete(id); }
        renderCodingRows();
      } })),
      h('th', { text: 'Date' }), h('th', { text: 'Description' }), h('th', { class: 'num', text: 'Amount' }), h('th', { class: 'col-acct', text: 'From' }), h('th', { text: 'Now in' }))),
    h('tbody', { id: 'code-rows' }));
  fill(root,
    h('div', { class: 'card-head' }, h('h2', { id: 'code-title', text: 'Code items' }),
      h('div', { class: 'row-form' },
        h('select', { id: 'code-view', 'aria-label': 'Show', onchange: e => { b.view = e.target.value; b.limit = 150; renderCoding(); } },
          h('option', { value: 'review', text: `Needs review (${left})`, selected: b.view === 'review' }), h('option', { value: 'all', text: `Everything (${everything.length})`, selected: b.view === 'all' })),
        h('select', { id: 'code-month', 'aria-label': 'Month', onchange: e => { b.ym = e.target.value; b.limit = 150; renderCoding(); } },
          h('option', { value: '', text: 'All months' }), months.map(ym => h('option', { value: ym, text: fmtMonth(ym), selected: ym === b.ym }))))),
    h('input', { type: 'search', id: 'code-q', placeholder: 'Search descriptions', 'aria-label': 'Search descriptions', value: b.q, oninput: e => { b.q = e.target.value; b.limit = 150; renderCodingRows(); } }),
    h('p', { class: 'sub code-note', id: 'code-note', role: 'status' }),
    undo && h('div', { class: 'row-form' }, undo),
    bar,
    h('div', { class: 'mx-wrap' }, head),
    h('p', { class: 'note', text: 'Tick items, or tap “Same merchant” to tick every charge from it. Hold Shift to tick a range. Pick an account once and tap Apply. The app remembers each merchant you code and files the rest the same way.' }),
    h('div', { id: 'code-more' }),
    fuelCard(),
    learnedList());
  renderCodingRows();
}
// Gas stations sell fuel and snacks under one name. When switched on, small charges there go to the account you pick
// (a convenience store, say) and the rest stay as gas. Changes apply straight away to every charge, past and future.
function fuelCard() {
  const f = state.fuel;
  const guess = f.below || (selectableCategories(state.trips).find(c => /conven|snack/i.test(CATEGORIES[c.id].name))?.id ?? '');
  const apply = change => {
    state.fuel = cleanFuel({ ...state.fuel, ...change }, id => !!CATEGORIES[id]);
    recompute(); render(); markDirty();
    const d = $('code-fuel'); if (d) d.open = true;
  };
  const choose = h('select', { id: 'fuel-below', 'aria-label': 'Account for small gas-station charges', onchange: e => apply({ below: e.target.value }) },
    h('option', { value: '', text: 'Choose an account…' }), categoryOptions(guess));
  return h('details', { class: 'fine', id: 'code-fuel', open: f.on },
    h('summary', { text: `Gas stations${f.on ? ': splitting by amount' : ''}` }),
    h('div', { style: 'display:flex;flex-direction:column;gap:10px;padding-top:8px' },
      h('p', { class: 'note', text: 'A gas station charges one name for fuel and for snacks. This tells them apart by size: small charges go to the account you choose, big ones stay as gas.' }),
      h('div', { class: 'row-form' },
        h('button', { type: 'button', class: 'switch', role: 'switch', id: 'fuel-on', 'aria-checked': String(f.on), 'aria-label': 'Split gas-station charges by amount',
          onclick: () => apply({ on: !state.fuel.on, below: state.fuel.below || $('fuel-below').value || guess }) }),
        h('span', { text: 'Split gas-station charges by amount' })),
      h('div', { class: 'row-form' },
        h('span', { text: 'Charges under $' }),
        h('input', { id: 'fuel-cutoff', type: 'text', inputmode: 'decimal', size: '4', value: String(f.cutoff / 100), 'aria-label': 'Cutoff in dollars',
          onchange: e => { const c = toCents(e.target.value); if (!(c >= 100)) { e.target.value = String(state.fuel.cutoff / 100); return; } apply({ cutoff: c }); } }),
        h('span', { text: 'go to' }), choose),
      h('p', { class: 'note', text: `At or over $${f.cutoff / 100} they stay in ${CATEGORIES.free_transport.name} (${CATEGORIES.free_transport.code}). Anything you code by hand on a single charge still wins.` })));
}

// What the app has learned from you: each merchant and where it files. Forget one and it goes back to the app's own judgement.
function learnedList() {
  const entries = Object.entries(state.learned).filter(([, r]) => CATEGORIES[r.c]).sort((a, b) => a[0].localeCompare(b[0]));
  return h('details', { class: 'fine', id: 'code-learned' },
    h('summary', { text: `What I’ve learned (${entries.length})` }),
    entries.length
      ? h('div', { style: 'display:flex;flex-direction:column;gap:2px;padding-top:6px' }, entries.map(([key, r]) => h('div', { class: 'learned-row' },
          h('span', { class: 'learned-key', text: key }), h('span', { class: 'learned-cat', text: `→ ${codeLabel(r.c)}` }),
          h('button', { type: 'button', class: 'linkbtn', text: 'Forget', 'aria-label': `Forget ${key}`, onclick: () => { state.learned = forget(state.learned, key); recompute(); render(); markDirty(); const d = $('code-learned'); if (d) d.open = true; } }))))
      : h('p', { class: 'note', text: 'Nothing yet. Code a charge and I’ll remember that merchant.' }));
}

const currentCodingList = () => filterItems(state.txs, state.bulk);

function renderCodingRows() {
  const b = state.bulk;
  const list = currentCodingList();
  const known = new Set(state.txs.map(t => t.id));
  for (const id of [...b.sel]) if (!known.has(id)) b.sel.delete(id);
  const shown = list.slice(0, b.limit), ids = shown.map(t => t.id);
  const body = $('code-rows');
  body.replaceChildren();
  for (const t of shown) {
    const on = b.sel.has(t.id);
    const tr = body.insertRow();
    tr.className = on ? 'sel' : '';
    tr.insertCell().className = 'pick';
    tr.cells[0].append(h('input', { type: 'checkbox', checked: on, 'aria-label': `Select ${t.description}, ${money2(t.cents)}`,
      onclick: e => {
        if (e.shiftKey && b.last) for (const id of rangeBetween(ids, b.last, t.id)) b.sel.add(id);
        else if (e.target.checked) b.sel.add(t.id); else b.sel.delete(t.id);
        b.last = t.id;
        renderCodingRows();
      } }));
    tr.insertCell().textContent = fmtDate(t.date);
    const d = tr.insertCell();
    d.append(h('span', { class: 'merchant', text: t.description }),
      h('button', { type: 'button', class: 'linkbtn similar', text: 'Same merchant', 'aria-label': `Select every charge like ${t.description}`,
        onclick: () => { for (const id of similarTo(list, t.description)) b.sel.add(id); renderCodingRows(); } }));
    const amt = tr.insertCell(); amt.className = 'num'; amt.textContent = money2(t.cents);
    const from = tr.insertCell(); from.className = 'col-acct'; from.textContent = sourceLabel(t.account);
    tr.insertCell().textContent = codeLabel(t.category);
  }
  if (!shown.length) { const r = body.insertRow(); const c = r.insertCell(); c.colSpan = 6; c.className = 'empty'; c.textContent = b.view === 'review' && !b.q && !b.ym ? 'Nothing left to review.' : 'Nothing matches.'; }
  const picked = state.txs.filter(t => b.sel.has(t.id));
  const total = picked.reduce((s, t) => s + t.cents, 0);
  $('code-count').textContent = picked.length ? `${plural(picked.length, 'item', 'items')} selected · ${money2(total)}` : `${plural(list.length, 'item', 'items')} shown. Tick some to code them together.`;
  $('code-bar').classList.toggle('on', picked.length > 0);
  $('code-apply').disabled = !picked.length;
  $('code-clear').disabled = !picked.length;
  const all = $('code-all');
  all.checked = ids.length > 0 && ids.every(id => b.sel.has(id));
  all.indeterminate = !all.checked && ids.some(id => b.sel.has(id));
  $('code-note').textContent = b.note;
  fill($('code-more'), list.length > shown.length && h('button', { type: 'button', class: 'btn ghost', id: 'code-more-btn', text: `Show ${Math.min(150, list.length - shown.length)} more (${list.length - shown.length} left)`, onclick: () => { b.limit += 150; renderCodingRows(); } }));
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
    const notes = [t.transfer === 'unmatched' && t.category === 'review' && 'other side not imported', t.transfer === 'unmatched' && t.category === 'transfer' && 'card payment · other account not imported', t.transfer === 'suggested' && 'possible transfer', t.askReimbursement && 'paid back?', t.chosen && 'your choice', t.byHand && 'entered by hand'].filter(Boolean);
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

function renderLedger() { renderGlControls(); renderGlRows(); renderGlExport(); }

// ---------- GL export: the ledger for a range of dates, as a file you can save or share ----------
function saveText(name, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function renderGlExport() {
  const box = $('gl-export');
  if (!state.txs.length) { box.replaceChildren(); return; }
  const x = state.exp;
  const dates = state.txs.map(t => t.date).sort();
  const first = dates[0], last = dates[dates.length - 1];
  const range = () => ({ from: $('exp-from').value || first, to: $('exp-to').value || last });
  const current = () => glExport(state.txs, { ...range(), names: $('exp-names').value });
  const status = h('p', { class: 'note', id: 'exp-status', role: 'status' });
  const refresh = () => {
    const out = current();
    x.from = $('exp-from').value; x.to = $('exp-to').value; x.names = $('exp-names').value;
    status.textContent = out.entries ? `${plural(out.entries, 'entry', 'entries')}, ${plural(out.rows.length, 'line', 'lines')}, ${money2(out.debit)} in debits and the same in credits.` : 'Nothing in those dates.';
    $('exp-download').disabled = $('exp-share') ? ($('exp-share').disabled = !out.entries) : !out.entries;
  };
  const file = () => { const { from, to } = range(); return { name: exportFileName(from, to), text: toCsv(...(o => [o.header, o.rows])(current())) }; };
  const canShare = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File(['x'], 'x.csv', { type: 'text/csv' })] });
  fill(box, h('details', { class: 'fine', id: 'gl-export-box', open: x.open, ontoggle: e => { x.open = e.target.open; } },
    h('summary', { text: 'Export the ledger for these dates' }),
    h('div', { class: 'stack', style: 'margin-top:8px' },
      h('p', { class: 'note', text: 'Saves every debit and credit in the dates you choose as a spreadsheet file (CSV), ready to analyse. It stays on this device until you send it somewhere. Account numbers and balances are never included.' }),
      h('div', { class: 'row-form' },
        h('label', { class: 'exp-field' }, h('span', { text: 'From' }), h('input', { id: 'exp-from', type: 'date', value: x.from || first, min: first, max: last, onchange: refresh })),
        h('label', { class: 'exp-field' }, h('span', { text: 'To' }), h('input', { id: 'exp-to', type: 'date', value: x.to || last, min: first, max: last, onchange: refresh }))),
      h('label', { class: 'exp-field' }, h('span', { text: 'How much wording to include' }),
        h('select', { id: 'exp-names', onchange: refresh }, NAME_MODES.map(([k, label]) => h('option', { value: k, text: label, selected: k === x.names })))),
      status,
      h('div', { class: 'row-form' },
        h('button', { type: 'button', class: 'btn', id: 'exp-download', text: 'Download CSV', onclick: () => { const f = file(); saveText(f.name, f.text); } }),
        canShare && h('button', { type: 'button', class: 'btn ghost', id: 'exp-share', text: 'Share…', onclick: async () => {
          const f = file();
          try { await navigator.share({ files: [new File([f.text], f.name, { type: 'text/csv' })], title: 'Ledger export' }); } catch { /* cancelled */ }
        } }),
        h('button', { type: 'button', class: 'btn ghost', id: 'exp-chart', text: 'Account list', onclick: () => { const c = chartExport(state.trips); saveText('chart-of-accounts.csv', toCsv(c.header, c.rows)); } })))));
  refresh();
}

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

// Sub accounts sit indented under their parent on every statement, and a parent account shows as a heading above its children.
const indentLevel = key => (key ? depthOf(key) : 0);
const indentClass = key => (indentLevel(key) ? ' sub-acct' : '');
const indentStyle = key => (indentLevel(key) ? `--depth:${indentLevel(key)}` : null);
// A parent account's row: bold, with the sum of what is under it. Its own money, if any, sits on an indented "(other)" line.
const entryRow = (e, extra = '') => h('tr', { class: e.kind === 'parent' ? 'parent-row' : '' },
  h('td', { class: 'acct' + indentClass(e.key) + (e.kind === 'own' ? ' own-line' : ''), style: e.kind === 'own' ? `--depth:${indentLevel(e.key) + 1}` : indentStyle(e.key) },
    e.code && h('span', { class: 'code', text: e.code }), e.name));

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
  const span = bal ? 14 : 13;
  const rollupTb = list => ({ openBal: list.reduce((t, r) => t + r.openBal, 0), change: list.reduce((t, r) => t + r.change, 0), total: list.reduce((t, r) => t + r.total, 0),
    byMonth: addMaps(list.map(r => r.byMonth)), balByMonth: addMaps(list.map(r => r.balByMonth)) });
  const ownTb = r => r.openBal !== 0 || tb.months.some(ym => r.byMonth[ym] !== 0 || r.balByMonth[ym] !== 0);
  for (const cls of [...new Set(shown.map(r => r.class))]) {
    body.append(h('tr', { class: 'hdr' }, h('td', { class: 'acct', text: cls }), h('td', { colspan: span })));
    for (const e of nestRows(shown.filter(r => r.class === cls), { rollup: rollupTb, hasOwn: ownTb })) {
      const d = e.data, tr = entryRow(e);
      if (bal) tr.append(h('td', { text: whole(d.openBal) }));
      tb.months.forEach((ym, i) => {
        if (!shownMonth(ym)) { tr.append(h('td', { class: 'empty', text: '·' })); return; }
        const v = cellValue(d, ym), target = e.kind === 'parent' ? null : drillFor(d, ym), td = h('td');
        if (v !== 0 && target) {
          td.append(h('button', { type: 'button', class: 'cell', text: whole(v),
            'aria-label': `${e.code || d.code} ${e.name}, ${MONTH_ABBR[i]}: ${money(v)}. Show this month’s transactions.`, onclick: () => drill(target) }));
        } else td.textContent = whole(v);
        tr.append(td);
      });
      tr.append(h('td', { class: 'total', text: whole(bal ? d.change : d.total) }));
      body.append(tr);
    }
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
  // drillOk lets a number open its transactions; sums and totals don't.
  const numbers = (tr, src, was, drillOk) => {
    if (!mo) {
      tr.append(h('td', { text: whole(src.open) }));
      bs.months.forEach((ym, i) => {
        if (!shown(ym)) { tr.append(dot()); return; }
        const v = src.byMonth[ym], target = drillOk && drillFor(src, ym), td = h('td');
        if (v !== 0 && target) {
          td.append(h('button', { type: 'button', class: 'cell', text: whole(v),
            'aria-label': `${src.name}, ${MONTH_ABBR[i]}: ${money(v)}. Show this month’s transactions.`, onclick: () => drill(target) }));
        } else td.textContent = whole(v);
        tr.append(td);
      });
      return;
    }
    const cur = src.byMonth[mo];
    if (!shown(mo)) { tr.append(dot(), dot(), dot()); return; }
    const target = drillOk && drillFor(src, mo), td = h('td');
    if (v0(cur) && target) {
      td.append(h('button', { type: 'button', class: 'cell', text: whole(cur),
        'aria-label': `${src.name}, ${MONTH_ABBR[mi]}: ${money(cur)}. Show this month’s transactions.`, onclick: () => drill(target) }));
    } else td.textContent = whole(cur);
    tr.append(td, h('td', { text: whole(was) }), h('td', { text: whole(cur - was) }));
  };
  const v0 = v => v !== 0;
  // A section's accounts: parents first with the sum of what is under them, then their sub accounts, indented.
  const sectionRows = (group, rows) => {
    const withWas = rows.map(r => ({ ...r, was: mo ? prior(group, r) : 0 }));
    const rollup = list => ({ open: list.reduce((t, r) => t + r.open, 0), was: list.reduce((t, r) => t + r.was, 0), byMonth: addMaps(list.map(r => r.byMonth)) });
    const hasOwn = r => r.open !== 0 || bs.months.some(ym => r.byMonth[ym] !== 0);
    for (const e of nestRows(withWas, { rollup, hasOwn })) {
      const tr = entryRow(e);
      numbers(tr, e.data, e.data.was, e.kind !== 'parent');
      body.append(tr);
    }
  };
  const totalRow = (label, group, t, cls) => {
    const tr = h('tr', { class: cls }, h('td', { class: 'acct', text: label }));
    numbers(tr, t, mo ? prior(group, null) : 0, false);
    body.append(tr);
  };

  header('Assets');
  sectionRows('assets', bs.assets.rows);
  totalRow('Total assets', 'assets', bs.assets, 'tot');
  if (bs.liabilities.rows.length) {
    header('Liabilities');
    sectionRows('liabilities', bs.liabilities.rows);
    totalRow('Total liabilities', 'liabilities', bs.liabilities, 'tot');
  }
  header('Equity');
  sectionRows('equity', bs.equity.rows);
  const earnings = h('tr', {}, h('td', { class: 'acct', text: 'Current year earnings' }));
  numbers(earnings, { open: 0, byMonth: bs.equity.earnings.byMonth, name: 'Current year earnings' }, mo ? prior('earnings', null) : 0, false);
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
  // One line of the statement. entry (optional) says it is a parent's sum or an "(other)" line, which changes how the label looks.
  const lineRow = (l, entry) => {
    const cls = entry ? (entry.kind === 'parent' ? 'parent-row' : '') : { row: '', subtotal: 'tot', net: 'net', running: 'run' }[l.kind];
    const label = entry ? [entry.code && h('span', { class: 'code', text: entry.code }), entry.name] : [l.code && h('span', { class: 'code', text: l.code }), l.name ?? l.label];
    const key = entry?.key ?? (l.kind === 'row' ? l.id : null);
    const own = entry?.kind === 'own';
    const tr = h('tr', { class: cls }, h('td', { class: 'acct' + (key ? indentClass(key) : '') + (own ? ' own-line' : ''),
      style: key ? (own ? `--depth:${indentLevel(key) + 1}` : indentStyle(key)) : null }, label));
    if (mo) {
      tr.append(m.hasData[mo] ? drillCell(l, mo, l.byMonth[mo]) : h('td', { class: 'empty', text: '·' }), h('td', { class: 'total', text: whole(ytdOf(l)) }));
      body.append(tr);
      return;
    }
    m.months.forEach(ym => {
      const v = l.byMonth[ym];
      if (v === null || (!m.hasData[ym])) { tr.append(h('td', { class: 'empty', text: '\u00b7' })); return; }
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
  };
  const rollupIs = list => ({ kind: 'sum', byMonth: addMaps(list.map(r => r.byMonth)), total: list.reduce((t, r) => t + r.total, 0), avg: list.reduce((t, r) => t + r.avg, 0) });
  for (let i = 0; i < m.lines.length; i++) {
    const l = m.lines[i];
    if (l.kind === 'header') {
      body.append(h('tr', { class: 'hdr' }, h('td', { class: 'acct', text: l.code ? `${l.code}  ${l.label}` : l.label }), h('td', { colspan: span })));
      const rows = [];
      while (m.lines[i + 1]?.kind === 'row') rows.push({ ...m.lines[++i], key: m.lines[i].id });
      for (const e of nestRows(rows, { rollup: rollupIs, hasOwn: r => r.total !== 0 })) lineRow(e.kind === 'parent' ? e.data : e.data, e);
      continue;
    }
    if (mo && l.kind === 'running') continue;
    lineRow(l, null);
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
const TABS = ['summary', 'budget', 'code', 'investments', 'savings', 'fs', 'tie'];
const TAB_LABELS = { summary: 'Summary', budget: 'Budget', code: 'Coding', investments: 'Investments', savings: 'Savings', fs: 'F/S', tie: 'Tie-out' };
const NEEDS_DATA = new Set(['budget', 'code', 'fs', 'tie']); // the other tabs are placeholders for now
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
  if (tab === 'code' && state.txs.length) { state.bulk.note = ''; renderCoding(); }
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
  syncHome();
  $('lock').hidden = !state.locked;
  $('app').hidden = state.locked;
  $('add-btn').hidden = state.locked || state.demo;
  if (state.locked) {
    for (const id of ['bgt-summary', 'bgt-weeks', 'bgt-savings', 'monthcard', 'where', 'habits', 'fs-tb', 'fs-bs', 'fs-is', 'plan-body', 'chips', 'gl-controls', 'coverage', 'code-body']) $(id).replaceChildren();
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
    renderCoding();
    renderFS(asOf);
    renderTie();
  }
  const toCode = state.txs.filter(t => t.category === 'review').length;
  $('tab-code').textContent = toCode ? `Coding · ${toCode}` : 'Coding';
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
const SETTINGS_TITLES = { home: 'Settings', opening: 'Opening balances', coding: 'TB coding', trips: 'Trips', saving: 'Saving & backup', sync: 'Sync' };

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
  ({ home: renderHomeScreen, opening: renderOpeningScreen, coding: renderCodingScreen, trips: renderTripsScreen, saving: renderSavingScreen, sync: renderSyncScreen })[screen](body);
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
    go('Sync', state.sync ? (syncStatus.at ? 'On · your devices are in step' : 'On') : 'Keep your iPad and phone in step', 'sync'),
    h('div', { class: 'menu-row' },
      h('span', {}, 'Dummy numbers', h('small', { text: 'Show made-up numbers instead of yours, for showing friends. Turning it off needs your passphrase.' })),
      h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(state.demo), 'aria-label': 'Dummy numbers', id: 'demo-switch', onclick: guard(msg, toggleDemo) }))),
    asking && h('form', { class: 'row-form', style: 'margin-top:10px', onsubmit: e => { e.preventDefault(); guard(msg, () => disableDemo($('demo-pass').value))(); } },
      h('input', { id: 'demo-pass', type: 'password', autocomplete: 'current-password', placeholder: 'Your passphrase', 'aria-label': 'Passphrase' }),
      h('button', { class: 'btn', type: 'submit', text: 'Show my data' })),
    h('div', { class: 'version-row' },
      h('span', { class: 'sub', id: 'app-version', text: `Version ${document.querySelector('meta[name="app-build"]')?.content ?? 'dev'}` }),
      h('button', { type: 'button', class: 'btn ghost small', id: 'reload-app', text: 'Reload app', onclick: () => location.reload() })),
    msg].filter(Boolean));
}

let syncNotice = '';   // a one-time message to show when the Sync screen redraws
function renderSyncScreen(body) {
  const msg = h('p', { class: 'msg', role: 'status', text: syncNotice });
  syncNotice = '';
  let revealed = false;
  const kids = [];
  if (PREVIEW) {
    body.append(h('p', { class: 'sub', text: 'Sync isn’t available in this preview page.' }));
    return;
  }
  if (state.demo) {
    body.append(h('p', { class: 'sub', text: 'Turn dummy numbers off to manage sync.' }));
    return;
  }
  const join = () => {
    const code = h('input', { id: 'join-code', type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'Paste the pairing code', 'aria-label': 'Pairing code' });
    const pass = h('input', { id: 'join-pass', type: 'password', autocomplete: 'current-password', placeholder: 'Your passphrase', 'aria-label': 'Passphrase' });
    const has = state.vault || state.raw.length;
    const go = guard(msg, async () => {
      msg.className = 'msg'; msg.textContent = 'Connecting…';
      await joinSync(code.value, pass.value);
    });
    return h('div', { class: 'stack' },
      h('h3', { class: 'set-h', text: 'Join from another device' }),
      h('p', { class: 'sub', text: 'On the device that already has your data, open Settings → Sync and copy its pairing code. Paste it here with your passphrase.' + (has ? ' This replaces the data on this device.' : '') }),
      code, pass,
      has ? twoStep('Replace this device’s data and join', 'Tap again to replace', () => go(), 'btn') : h('button', { class: 'btn', type: 'button', id: 'join-go', text: 'Join', onclick: () => go() }));
  };
  if (!state.sync) {
    kids.push(
      h('p', { class: 'sub', text: 'Keeps your data in step across your devices. It is encrypted on this device with your passphrase before it is sent, so your sync server only ever holds unreadable data. Nothing else leaves the device.' }),
      h('button', { class: 'btn', type: 'button', id: 'sync-on', text: 'Turn on sync', onclick: guard(msg, async () => {
        msg.className = 'msg'; msg.textContent = 'Setting up…';
        await enableSync();
        renderSettingsScreen();
        const m = document.querySelector('#settings-body .msg'); if (m) { m.className = 'msg'; m.textContent = 'Sync is on. Copy the pairing code below to your other device.'; }
      }) }),
      join());
  } else {
    const code = pairingCode(state.sync);
    const status = syncStatus.busy ? 'Syncing…' : syncStatus.error ? syncStatus.error : syncStatus.conflict ? 'Waiting for your choice (see the banner at the top).'
      : syncStatus.at ? `In step as of ${new Date(syncStatus.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : 'Not synced yet.';
    kids.push(
      h('p', { class: syncStatus.error ? 'msg error' : 'sub', id: 'sync-status', text: status }),
      h('button', { class: 'btn', type: 'button', id: 'sync-now', text: 'Sync now', onclick: () => { syncNow(); } }),
      h('h3', { class: 'set-h', text: 'Add another device' }),
      h('p', { class: 'sub', text: 'On the other device, open Settings → Sync → Join, then paste this code and enter your passphrase. Treat the code like a key to your sync server: it can’t unlock your data, but anyone with it could overwrite or delete the synced copy.' }),
      h('div', { class: 'row-form' },
        h('code', { id: 'pair-code', class: 'pair-code', text: revealed ? code : '•••••-•••••-•••••-•••••-•••••-•••••' }),
        h('button', { class: 'btn ghost', type: 'button', id: 'pair-show', text: 'Show', onclick: e => { revealed = !revealed; $('pair-code').textContent = revealed ? code : '•••••-•••••-•••••-•••••-•••••-•••••'; e.currentTarget.textContent = revealed ? 'Hide' : 'Show'; } }),
        h('button', { class: 'btn ghost', type: 'button', id: 'pair-copy', text: 'Copy', onclick: async () => {
          try { await navigator.clipboard.writeText(code); msg.className = 'msg'; msg.textContent = 'Copied. Paste it on your other device.'; }
          catch { revealed = true; $('pair-code').textContent = code; msg.className = 'msg'; msg.textContent = 'Couldn’t copy automatically. Select the code and copy it.'; }
        } })),
      h('h3', { class: 'set-h', text: 'Turn off' }),
      h('div', { class: 'row-form' },
        twoStep('Stop syncing on this device', 'Tap again to stop', () => { disableSync(); renderSettingsScreen(); }),
        twoStep('Delete the synced copy', 'Tap again to delete it', guard(msg, async () => { await deleteServerCopy(); renderSettingsScreen(); }))),
      h('p', { class: 'note', text: 'Stopping keeps the copy on the server and your other devices keep syncing. Deleting removes the server copy for every device; each keeps its own data.' }));
  }
  body.append(...kids, msg);
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
let addingAccount = false;   // whether the New account form is open
function renderCodingScreen(body) {
  const msg = h('p', { class: 'msg', role: 'status' });
  const refresh = focusId => { recompute(); render(); markDirty(); renderSettingsScreen(); if (focusId) document.getElementById(focusId)?.focus(); };
  const say = (text, bad = false) => { const m = document.querySelector('#settings-body .msg') ?? msg; m.className = bad ? 'msg error' : 'msg'; m.textContent = text; };
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
      if (/^vac[1-9]$/.test(key)) state.trips = updateTrip(state.trips, Number(key.slice(3)), { name: value });     // a trip is renamed here too
      else state.names = setName(state.names, key, value);
      refresh(`name-${key}`);
    } catch (err) {
      input.value = codingList(state.trips, state.coding, state.names).find(r => r.key === key).name;
      input.classList.add('bad');
      msg.className = 'msg error'; msg.textContent = err.message;
    }
  };
  const list = codingList(state.trips, state.coding, state.names);
  const byKey = Object.fromEntries(list.map(r => [r.key, r]));

  // Add an account. It takes the next free standard number in its section; drag it to wherever it belongs.
  const kindSel = h('select', { id: 'acct-kind', 'aria-label': 'What kind of account' }, [...ADD_KINDS, ['trip', 'Vacation (a trip, with its own five accounts)']].map(([k, label]) => h('option', { value: k, text: label })));
  const acctName = h('input', { id: 'acct-name', type: 'text', maxlength: '60', placeholder: 'Account name', 'aria-label': 'Account name' });
  const acctMatch = h('input', { id: 'acct-match', type: 'text', maxlength: '80', placeholder: 'Charges containing… e.g. NETFLIX (optional)', 'aria-label': 'Auto-file charges containing' });
  const acctNumber = h('input', { id: 'acct-number', type: 'text', inputmode: 'numeric', maxlength: '4', placeholder: 'Number (optional)', 'aria-label': 'Account number, optional' });
  const sectionSel = h('select', { id: 'acct-section', 'aria-label': 'Section for the parent account', hidden: true },
    SECTIONS.map(([d, label]) => h('option', { value: d, text: `${label} (${d}000s)`, selected: d === '1' })));
  const tripStart = h('input', { id: 'acct-start', type: 'date', hidden: true, 'aria-label': 'Trip start' });
  const tripEnd = h('input', { id: 'acct-end', type: 'date', hidden: true, 'aria-label': 'Trip end' });
  kindSel.addEventListener('change', () => {
    const header = kindSel.value === 'header', trip = kindSel.value === 'trip';
    sectionSel.hidden = !header || !!acctNumber.value;
    acctMatch.hidden = header || trip; acctNumber.hidden = trip;
    tripStart.hidden = !trip; tripEnd.hidden = !trip;
    acctName.placeholder = trip ? 'Trip name, e.g. Lisbon' : 'Account name';
  });
  acctNumber.addEventListener('input', () => { sectionSel.hidden = kindSel.value !== 'header' || !!acctNumber.value; });
  const addIt = () => {
    try {
      if (kindSel.value === 'trip') {                       // a vacation is a trip: it takes the next of 7100, 7200... with its five accounts
        const name = acctName.value.trim();
        const before = new Set(state.trips.map(t => t.slot));
        state.trips = addTrip(state.trips, { name, start: tripStart.value, end: tripEnd.value });
        const slot = state.trips.find(t => !before.has(t.slot)).slot;
        addingAccount = false;
        recompute(); render(); markDirty(); renderSettingsScreen();
        say(`Added ${name} as 7${slot}00, with Travel, Lodging, Food & drinks, Entertainment and Purchases under it.`);
        return;
      }
      const out = addAccount(state.customs, state.coding, kindSel.value, acctName.value, acctMatch.value, { number: acctNumber.value, section: sectionSel.value });
      state.customs = out.customs;
      const name = acctName.value.trim();
      addingAccount = false;
      recompute(); render(); markDirty(); renderSettingsScreen();
      say(`Added ${out.code} ${name}. Drag its ≡ handle onto an account to put it underneath.`);
          } catch (err) { msg.className = 'msg error'; msg.textContent = err.message; }
  };
  for (const el of [acctName, acctMatch]) el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addIt(); } });

  // Dragging: grab ≡, drop on an account to nest it (numbers follow: tens, then twos), or on a section title to bring it back to the top.
  const tryMove = (key, target) => moveAccount({ coding: state.coding, parents: state.parents, customs: state.customs }, key, target);
  const startDrag = (e, r) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    try { handle.setPointerCapture(e.pointerId); } catch { /* not every browser lets a pointer be captured */ }
    const ghost = h('div', { class: 'drag-ghost', text: `${r.code} ${r.name}` });
    document.body.append(ghost);
    const scroller = $('settings-body').closest('.overlay') ?? $('settings-body').parentElement;
    let over = null, ok = false;
    const clear = () => { document.querySelectorAll('.drop-ok, .drop-no').forEach(n => n.classList.remove('drop-ok', 'drop-no')); over = null; ok = false; };
    const move = ev => {
      ghost.style.left = `${ev.clientX + 12}px`; ghost.style.top = `${ev.clientY - 14}px`;
      const rect = scroller.getBoundingClientRect();
      if (ev.clientY < rect.top + 60) scroller.scrollTop -= 14; else if (ev.clientY > rect.bottom - 60) scroller.scrollTop += 14;
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-drop]');
      if (!el) { clear(); return; }
      if (el === over) return;
      clear(); over = el;
      try { tryMove(r.key, el.dataset.drop === 'top' ? (el.dataset.cls === r.code[0] ? 'top' : 'x') : el.dataset.drop); ok = !(el.dataset.drop === 'top' && el.dataset.cls !== r.code[0]); }
      catch { ok = false; }
      el.classList.add(ok ? 'drop-ok' : 'drop-no');
    };
    const end = ev => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', cancel);
      ghost.remove();
      const el = over, good = ok;
      clear();
      if (ev.type === 'pointerup' && el) {
        const target = el.dataset.drop;
        try {
          if (target === 'top' && el.dataset.cls !== r.code[0]) throw new Error('Accounts stay in their own section: assets, income, expenses and so on.');
          const next = tryMove(r.key, target);
          state.coding = next.coding; state.parents = next.parents; state.customs = next.customs;
          refresh();
          const now = state.coding[r.key] ?? CATEGORIES[r.key].code;
          say(target === 'top' ? `Moved ${r.name} to the top level: ${now}.` : `Moved ${r.name} under ${byKey[target].name}: now ${now}.`);
        } catch (err) { say(err.message, true); }
      } else if (ev.type === 'pointerup' && !good) { /* dropped on nothing */ }
    };
    const cancel = ev => end(ev);
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', cancel);
    move(e);
  };

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
            say(`Deleted ${r.code} ${r.name}. Everything in it moved to ${CATEGORIES[pick.value].code} ${CATEGORIES[pick.value].name}.`);
          } catch (err) { msg.className = 'msg error'; msg.textContent = err.message; }
        } }),
        h('button', { type: 'button', class: 'btn ghost small', text: 'Cancel', onclick: () => { removingKey = null; renderSettingsScreen(); } })));
  };

  const rows = [];
  for (const cls of [...new Set(list.map(r => r.class))]) {
    const digit = list.find(x => x.class === cls).code[0];
    rows.push(h('h3', { class: 'set-h', 'data-drop': 'top', 'data-cls': digit, text: cls }));
    for (const r of list.filter(x => x.class === cls)) {
      rows.push(h('div', { class: 'code-row' + (r.depth ? ' nested' : '') + (r.hasKids ? ' parent' : '') + (r.editable ? '' : ' dim'), style: r.depth ? `--depth:${r.depth}` : null, ...(r.droppable ? { 'data-drop': r.key } : {}) },
        r.movable
          ? h('button', { type: 'button', class: 'grip', 'aria-label': `Drag ${r.code} ${r.name} to move it`, title: 'Drag onto an account to nest it', onpointerdown: e => startDrag(e, r) }, '≡')
          : h('span', { class: 'grip off' }),
        r.editable
          ? h('input', { id: `code-${r.key}`, type: 'text', inputmode: 'numeric', maxlength: '4', value: r.code, class: r.changed ? 'changed' : '',
              'aria-label': `TB number for ${r.name}`, onchange: e => change(r.key, e.target.value, e.target) })
          : h('span', { class: 'code fixed', text: r.code }),
        r.renamable
          ? h('input', { id: `name-${r.key}`, type: 'text', maxlength: '60', value: r.name, class: 'name' + (r.renamed ? ' changed' : ''),
              'aria-label': `Name of account ${r.code}`, onchange: e => rename(r.key, e.target.value, e.target) })
          : h('span', { text: r.name }),
        h('span', { class: 'row-actions' },
          r.canRemove && h('button', { type: 'button', class: 'btn ghost danger small', text: 'Delete', 'aria-label': `Delete ${r.code} ${r.name}`,
            onclick: () => { removingKey = removingKey === r.key ? null : r.key; renderSettingsScreen(); } }),
          r.custom
            ? twoStep('Remove', 'Tap again', () => {
                const out = removeSub(state.customs, r.key);
                state.customs = out.customs;
                for (const [tid, cat] of Object.entries(state.overrides)) if (out.removed.includes(cat)) delete state.overrides[tid];
                refresh();
              }, 'btn ghost danger small')
            : null)));
      const mine = r.custom ? state.customs.find(x => x.id === r.key) : null;
      if (mine?.match?.length) {      // only accounts that actually file by keyword show the extra line
        rows.push(h('div', { class: 'match-row' + (r.depth ? ' nested' : ''), style: r.depth ? `--depth:${r.depth}` : null },
          h('input', { id: `match-${r.key}`, type: 'text', maxlength: '80', value: (mine?.match ?? []).join(', '), placeholder: 'Auto-file charges containing… e.g. NETFLIX',
            'aria-label': `Auto-file charges containing, for ${r.name}`,
            onchange: e => { state.customs = setMatch(state.customs, r.key, e.target.value); refresh(`match-${r.key}`); } })));
      }
      if (removingKey === r.key && r.canRemove) rows.push(deletePanel(r));
    }
  }
  body.append(
    h('p', { class: 'sub', text: 'Add an account, then drag its ≡ handle onto another account to tuck it underneath. Standard accounts count in hundreds (5100, 5200…), sub accounts in tens (5110, 5120…), and the level below that in twos (5112, 5114…). Rename anything, delete accounts you don’t use (their transactions move into another one; Reset brings them all back), and give an account some words, like NETFLIX, to file matching charges there automatically.' }),
    msg,
    addingAccount
      ? h('div', { class: 'row-form sub-add' }, acctName, kindSel, sectionSel, acctNumber, acctMatch, tripStart, tripEnd,
          h('button', { type: 'button', class: 'btn', text: 'Add', onclick: addIt }),
          h('button', { type: 'button', class: 'btn ghost', text: 'Cancel', onclick: () => { addingAccount = false; renderSettingsScreen(); } }))
      : h('div', { class: 'row-form sub-add' }, h('button', { type: 'button', class: 'btn', id: 'new-account', text: 'New account', onclick: () => { addingAccount = true; renderSettingsScreen(); document.getElementById('acct-name')?.focus(); } })),
    !list.some(r => r.header && r.code[0] === '1') && h('div', { class: 'row-form', style: 'margin: 4px 0 8px' },
      twoStep('Set up assets: Checking, Savings, Receivable, Investments', 'Tap again to set up', () => {
        try {
          const out = organizeAssets({ coding: state.coding, parents: state.parents, customs: state.customs });
          state.coding = out.coding; state.parents = out.parents; state.customs = out.customs;
          refresh();
          say('Assets are set up: 1000 Checking, 1200 Savings, 1300 Accounts Receivable, 1400 Investments, with your accounts under them.');
        } catch (err) { msg.className = 'msg error'; msg.textContent = err.message; }
      }, 'btn ghost')),
    h('div', {}, rows),
    h('div', { class: 'row-form', style: 'margin-top:12px' },
      twoStep('Reset everything to the defaults', 'Tap again to reset', () => {
        state.coding = {}; state.names = {}; state.parents = {}; state.removed = {}; refresh();
      })));
}

function renderTripsScreen(body) {
  const msg = h('p', { class: 'msg', id: 'trip-msg', role: 'status' });
  const add = guard(msg, () => {
    state.trips = addTrip(state.trips, { name: $('trip-name').value, start: $('trip-start').value, end: $('trip-end').value });
    recompute(); render(); renderSettingsScreen(); markDirty();
  });
  body.append(
    h('p', { class: 'sub', text: `Each trip is an account named after it: the first is 7100, the second 7200, up to ${MAX_TRIPS}. Every trip comes with the same five accounts under it: Travel (7110), Lodging (7120), Food & drinks (7130), Entertainment (7140) and Purchases (7150). The trip shows the total of the five. Vacation charges file under the trip they fall in, from 45 days before to 10 days after. Change any single one from GL Detail.` }),
    state.trips.length
      ? h('div', {}, state.trips.map(t => {
          const change = field => e => {
            try { state.trips = updateTrip(state.trips, t.slot, { [field]: e.target.value }); recompute(); render(); markDirty(); renderSettingsScreen(); }
            catch (err) { msg.className = 'msg error'; msg.textContent = err.message; renderSettingsScreen(); const m = $('trip-msg'); m.className = 'msg error'; m.textContent = err.message; }
          };
          return h('div', { class: 'trip trip-edit' },
            h('span', { class: 'code', text: `7${t.slot}00` }),
            h('div', { class: 'trip-fields' },
              h('input', { id: `trip-name-${t.slot}`, type: 'text', maxlength: '60', value: t.name, 'aria-label': `Name of trip ${t.slot}`, onchange: change('name') }),
              h('div', { class: 'row-form' },
                h('input', { id: `trip-start-${t.slot}`, type: 'date', value: t.start, 'aria-label': `Start of ${t.name}`, onchange: change('start') }),
                h('input', { id: `trip-end-${t.slot}`, type: 'date', value: t.end, 'aria-label': `End of ${t.name}`, onchange: change('end') }))),
            twoStep('Remove', 'Tap again to remove', guard(msg, () => { state.trips = removeTrip(state.trips, t.slot); recompute(); render(); renderSettingsScreen(); markDirty(); }), 'btn ghost'));
        }))
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

// ---------- the home screen: a picture, the time, and a swipe up to the password ----------
// Shown whenever something has to be unlocked: the access code on a new device, or your passphrase on a device with saved data.
const ROOT_EL = document.documentElement;
const HAS_VAULT_KEY = 'my-budget-has-vault';
let homeClock = null;
function tickHome() {
  const now = new Date();
  $('home-time').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
  $('home-date').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}
function openHome() {
  if (!ROOT_EL.hasAttribute('data-home')) return;
  ROOT_EL.setAttribute('data-open', '1');
  setTimeout(() => ($('gate-code') && !$('gate').hidden ? $('gate-code') : $('lock-pass'))?.focus(), 380);
}
function closeHome() {
  ROOT_EL.removeAttribute('data-open');
  document.activeElement?.blur?.();
}
// Decides whether the home picture should be up, from what is true right now.
function syncHome() {
  const need = ROOT_EL.hasAttribute('data-gated') || state.locked;
  if (need) ROOT_EL.setAttribute('data-home', '1'); else { ROOT_EL.removeAttribute('data-home'); ROOT_EL.removeAttribute('data-open'); }
  lsSet(HAS_VAULT_KEY, state.vault || state.envelope ? '1' : null);
  if (need && !homeClock) { tickHome(); homeClock = setInterval(tickHome, 15000); }
  if (!need && homeClock) { clearInterval(homeClock); homeClock = null; }
}
(() => {
  const home = $('home');
  let startY = null;
  home.addEventListener('pointerdown', e => { startY = e.clientY; });
  home.addEventListener('pointermove', e => {
    if (startY === null || ROOT_EL.hasAttribute('data-open')) return;
    if (startY - e.clientY > 50) { startY = null; openHome(); }
  });
  for (const t of ['pointerup', 'pointercancel']) home.addEventListener(t, e => {
    const moved = startY === null ? 99 : Math.abs(startY - e.clientY);
    // a tap on the picture (not the button) puts the sheet away again
    if (t === 'pointerup' && moved < 8 && ROOT_EL.hasAttribute('data-open') && !e.target.closest('#home-hint')) closeHome();
    startY = null;
  });
  home.addEventListener('wheel', e => { if (e.deltaY > 20) openHome(); }, { passive: true });
  $('home-hint').addEventListener('click', openHome);
  document.addEventListener('keydown', e => {
    if (!ROOT_EL.hasAttribute('data-home')) return;
    if (e.key === 'ArrowUp' || (e.key === 'Enter' && !ROOT_EL.hasAttribute('data-open') && document.activeElement === document.body)) { e.preventDefault(); openHome(); }
    if (e.key === 'Escape') closeHome();
  });
})();

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
// The front door: on a site built with an access code, nothing else starts until the right code is entered.
async function openDoorThenBoot() {
  const spec = parseAccess(document.querySelector('meta[name="app-access"]')?.getAttribute('content'));
  if (!spec || !document.documentElement.hasAttribute('data-gated')) { boot(); return; }
  $('gate').hidden = false;
  syncHome();
  const form = $('gate-form'), input = $('gate-code'), msg = $('gate-msg'), btn = $('gate-btn');
  let misses = 0;
  input.focus();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Checking…';
    let ok = false;
    try { ok = await checkCode(input.value, spec); } catch { ok = false; }
    if (ok) {
      try { localStorage.setItem(ACCESS_FLAG, fingerprint(spec)); } catch { /* it just asks again next time */ }
      document.documentElement.removeAttribute('data-gated');
      document.title = 'My Budget';
      input.value = ''; $('gate').hidden = true;
      syncHome();
      boot();
      return;
    }
    misses++;
    msg.className = 'msg error'; msg.textContent = 'That isn’t right.';
    input.value = '';
    await new Promise(r => setTimeout(r, Math.min(8000, 1000 * misses)));        // a little slower with each wrong try
    btn.disabled = false; input.focus();
  }, { once: false });
}
openDoorThenBoot();

// Ask the browser to keep the app files fresh (see sw.js). Without it the app still works; updates just arrive a little later.
if (!PREVIEW && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* private windows and old browsers: carry on */ });
