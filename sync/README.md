# The sync server (optional)

This is what lets your iPad and phone share the same budget. It is a small Cloudflare Worker that stores **one encrypted
blob per vault**. The app encrypts your data with your passphrase on the device before sending it, so this server never
holds anything it can read.

You only need this if you want sync. The app works fully on its own without it.

## What it can and can't do
- It can't read, search or change your data. It never sees your passphrase.
- Each vault is found by a long random id and protected by a long random token (made on your device). Only a hash of the token is stored.
- Saves carry the revision they are based on, so two devices can't silently overwrite each other. The last three versions are kept.
- It answers only to the app's address in the browser, and responses are never cached.

## Setting it up (about 10 minutes, all in the Cloudflare dashboard)
1. **Create the database.** Workers & Pages → (left menu) **Storage & Databases → D1** → **Create database**. Name it `budget-sync-db`.
2. **Create the Worker.** Workers & Pages → **Create → Create Worker**. Name it `budget-sync` → **Deploy**. Then **Edit code**, delete what is there, paste the whole of `sync/worker.js` from this repository, and **Deploy**.
3. **Connect the database.** Worker → **Settings → Bindings → Add → D1 database**. Variable name: `DB` (exactly). Choose `budget-sync-db`. Save.
4. **Give it its address.** Worker → **Settings → Domains & Routes → Add → Custom domain** → `sync.millhaus.app`. (Cloudflare creates the DNS record for you.)
5. **Check it.** Open `https://sync.millhaus.app/v1/vault/test` in a browser. You should see `{"error":"not found"}`. That means it is up.
6. In the app: **Settings → Sync → Turn on sync**.

If your app lives at a different address than `https://app.millhaus.app`, add a Worker variable `ALLOWED_ORIGIN` set to it (Settings → Variables).

## Keeping it safe
- Turn on Cloudflare two-factor, as with your domain.
- Optional: Security → WAF → Rate limiting rule for `sync.millhaus.app`, for example 60 requests a minute per IP.
- The server address is built into the app's security policy (`connect-src` in `app/index.html`) and `SYNC_ORIGIN` in `app/src/sync.js`. A test fails if the two ever disagree or if anything else is allowed.

## Tests
`test/syncserver.test.js` runs this Worker's real code against a real SQLite database. `test/e2e-sync.cjs` runs two browsers against it.
