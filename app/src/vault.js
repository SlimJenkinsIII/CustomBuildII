// Encrypts your data with a passphrase before it is stored or exported. Uses the browser's built-in
// cryptography (Web Crypto): PBKDF2-SHA256 turns the passphrase into a key, AES-256-GCM encrypts and
// authenticates. A wrong passphrase, or any tampering with the stored data, makes decryption fail.
// There is no recovery: if the passphrase is lost, the data cannot be read by anyone, including us.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const DEFAULT_ITERATIONS = 600000;
const MIN_ITERATIONS = 1000;      // lower bound, so an edited backup file cannot weaken the key
const MAX_ITERATIONS = 5000000;   // upper bound, so an edited file cannot freeze the app

const toB64 = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = str => Uint8Array.from(atob(str), ch => ch.charCodeAt(0));

async function deriveKey(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// A vault is the unlocked key plus the settings needed to save again. It lives only in memory.
export async function createVault(passphrase, iterations = DEFAULT_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { key: await deriveKey(passphrase, salt, iterations), salt, iterations };
}

// Encrypt any JSON-friendly object. A fresh random IV is used for every save.
export async function seal(vault, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vault.key, encoder.encode(JSON.stringify(data)));
  return {
    app: 'my-budget', v: 1, kdf: 'PBKDF2-SHA256', iter: vault.iterations,
    salt: toB64(vault.salt), iv: toB64(iv), data: toB64(new Uint8Array(cipher)),
  };
}

export function looksLikeEnvelope(env) {
  return !!env && env.app === 'my-budget' && env.v === 1 && env.kdf === 'PBKDF2-SHA256'
    && Number.isInteger(env.iter) && env.iter >= MIN_ITERATIONS && env.iter <= MAX_ITERATIONS
    && ['salt', 'iv', 'data'].every(k => typeof env[k] === 'string');
}

// Returns { vault, data } or throws. The same message covers a wrong passphrase and a damaged file on purpose.
export async function unlock(envelope, passphrase) {
  if (!looksLikeEnvelope(envelope)) throw new Error('This is not a My Budget backup.');
  const salt = fromB64(envelope.salt);
  const key = await deriveKey(passphrase, salt, envelope.iter);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(envelope.iv) }, key, fromB64(envelope.data));
  } catch {
    throw new Error('Wrong passphrase, or the data is damaged.');
  }
  return { vault: { key, salt, iterations: envelope.iter }, data: JSON.parse(decoder.decode(plain)) };
}
