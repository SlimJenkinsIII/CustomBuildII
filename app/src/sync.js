// Keeps your devices in step. The data is encrypted on the device with your passphrase BEFORE it is sent, and the
// server only ever holds that unreadable blob. This file is the only place in the app that talks to a server, and it
// talks to exactly one address (the Content-Security-Policy in index.html allows that address and nothing else).

export const SYNC_ORIGIN = 'https://sync.millhaus.app';

// ---------- pairing code: the id and the secret token, as something you can copy to another device ----------
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';           // no i, l, o or u, so it can't be misread
const toBase32 = bytes => {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
};
const checkOf = text => { let sum = 7; for (const ch of text) sum = (sum * 31 + ALPHABET.indexOf(ch) + 1) % 1024; return ALPHABET[sum >> 5] + ALPHABET[sum & 31]; };

export function newSyncKeys(random = n => crypto.getRandomValues(new Uint8Array(n))) {
  return { id: toBase32(random(16)), token: toBase32(random(20)) };      // 26 and 32 characters
}
export const validKeys = k => !!k && /^[a-z0-9]{26}$/.test(k.id ?? '') && /^[a-z0-9]{32}$/.test(k.token ?? '');
export const cleanKeys = k => (validKeys(k) ? { id: k.id, token: k.token } : null);

// 60 characters, shown in groups: ABCDE-FGHJK-...
export function pairingCode(keys) {
  const body = keys.id + keys.token;
  return (body + checkOf(body)).toUpperCase().match(/.{1,5}/g).join('-');
}
// Accepts what you paste (any spacing or dashes, upper or lower case) and returns the keys, or throws a plain reason.
export function parsePairingCode(text) {
  const raw = String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/[o]/g, '0').replace(/[il]/g, '1');
  if (raw.length !== 60 || [...raw].some(ch => !ALPHABET.includes(ch))) throw new Error('That code isn’t the right length. Copy the whole code from the other device.');
  const body = raw.slice(0, 58);
  if (checkOf(body) !== raw.slice(58)) throw new Error('That code has a typo in it. Copy it again from the other device.');
  return { id: body.slice(0, 26), token: body.slice(26) };
}

// ---------- the server, from the device's side ----------
export class SyncError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }     // 'offline' | 'denied' | 'server'
}

export function createSyncClient({ origin = SYNC_ORIGIN, fetchImpl = (...args) => fetch(...args) } = {}) {
  const call = async (id, token, init = {}) => {
    let res;
    try {
      res = await fetchImpl(`${origin}/v1/vault/${id}`, {
        ...init, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });
    } catch { throw new SyncError('offline', 'Couldn’t reach the sync server. Your data is safe on this device and will sync when you’re back online.'); }
    if (res.status === 401) throw new SyncError('denied', 'The sync server refused this code. Pair this device again.');
    return res;
  };
  return {
    // Returns { rev, envelope } or null when the server has nothing for this id.
    async pull(id, token) {
      const res = await call(id, token);
      if (!res.ok) throw new SyncError('server', 'The sync server had a problem. Try again in a minute.');
      const body = await res.json();
      if (body.exists === false) return null;
      let envelope;
      try { envelope = JSON.parse(body.envelope); } catch { throw new SyncError('server', 'The copy on the sync server is damaged.'); }
      return { rev: body.rev, envelope, updated: body.updated };
    },
    // Saves the envelope on top of revision baseRev (0 for the first save). { ok: true, rev } or { ok: false, rev } if someone saved first.
    async push(id, token, baseRev, envelope) {
      const res = await call(id, token, { method: 'PUT', headers: { 'if-match': String(baseRev), 'content-type': 'application/json' }, body: JSON.stringify(envelope) });
      if (res.status === 409) return { ok: false, rev: (await res.json()).rev };
      if (res.status === 413) throw new SyncError('server', 'Your data is too big for the sync server.');
      if (!res.ok) throw new SyncError('server', 'The sync server had a problem. Try again in a minute.');
      return { ok: true, rev: (await res.json()).rev };
    },
    async remove(id, token) {
      const res = await call(id, token, { method: 'DELETE' });
      if (!res.ok) throw new SyncError('server', 'The sync server had a problem. Try again in a minute.');
    },
  };
}

// What to do, given the revision this device last synced (baseRev), whether it has changes since, and what the server has.
//   push      save this device's data to the server
//   pull      take the server's newer data
//   conflict  both changed: ask which to keep
//   rollback  the server has OLDER data than this device last saw: don't trust it, ask
//   idle      already in step
export function planSync({ baseRev, dirty, remote }) {
  if (!remote) return 'push';                                   // nothing there yet (first save, or the server copy was deleted)
  if (remote.rev === baseRev) return dirty ? 'push' : 'idle';
  if (remote.rev > baseRev) return dirty ? 'conflict' : 'pull';
  return 'rollback';
}
