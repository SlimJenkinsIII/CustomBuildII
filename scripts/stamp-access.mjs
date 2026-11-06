// Turns an access code into the public "salt + slow hash" the site checks against. The code itself is never written anywhere.
// Usage: ACCESS_CODE=... node scripts/stamp-access.mjs _site/index.html
import { createHash, pbkdf2Sync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
const code = (process.env.ACCESS_CODE ?? '').trim();
if (!code) { console.log('No ACCESS_CODE set: the site will open without a front door.'); process.exit(0); }
if (code.length < 8) { console.error('ACCESS_CODE must be at least 8 characters.'); process.exit(1); }
const iter = 600000;
// The salt comes from the code itself, so rebuilding the site with the same code gives the same result and
// devices that were already let in stay let in. A new code changes it, and everyone is asked again.
const salt = createHash('sha256').update(`my-budget-access-salt|${code}`).digest().subarray(0, 16);
const hash = pbkdf2Sync(code, salt, iter, 32, 'sha256').toString('hex');
const value = `v1.${iter}.${salt.toString('base64url')}.${hash}`;
const html = readFileSync(file, 'utf8');
if (!html.includes('<meta name="app-access" content="">')) { console.error('index.html has no access placeholder.'); process.exit(1); }
writeFileSync(file, html.replace('<meta name="app-access" content="">', `<meta name="app-access" content="${value}">`));
console.log('Front door is on: visitors need the access code.');
