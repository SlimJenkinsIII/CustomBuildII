// The front door. When the published site is built with an access code, a visitor sees only a plain password box,
// not the app. The code is never stored in the site: only a salted, slow hash of it (so it can't simply be read out).
//
// Be clear about what this is: a door, not a vault. It keeps people who stumble onto the address out, and it
// slows a determined one. Your actual data is protected separately, by your passphrase and encryption, and a device
// that has never had your data has nothing in it to protect.

export const ACCESS_FLAG = 'my-budget-access';

const b64u = str => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
const toHex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');

// "v1.<iterations>.<salt>.<hash>" -> the pieces, or null when the site was built without an access code.
export function parseAccess(content) {
  if (!content) return null;
  const m = /^v1\.(\d{4,8})\.([A-Za-z0-9_-]{16,})\.([0-9a-f]{64})$/.exec(content.trim());
  if (!m) return null;
  const iter = Number(m[1]);
  if (iter < 100000 || iter > 5000000) return null;
  return { iter, salt: b64u(m[2]), hash: m[3] };
}

export async function deriveHex(code, salt, iter) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
  return toHex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, material, 256));
}

// Compares without stopping at the first difference.
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

export async function checkCode(code, spec) {
  const text = String(code ?? '').trim();
  if (!text) return false;
  return same(await deriveHex(text, spec.salt, spec.iter), spec.hash);
}

// What a device remembers once it has been let in. If the code is ever changed, this stops matching and the door closes again.
export const fingerprint = spec => spec.hash.slice(0, 16);
