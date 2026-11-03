# My Budget

A private, on-device personal budget app. Statements are read in your browser and stored only on your device.

- **Privacy rules** live in `app/index.html` (browser-enforced: no outgoing connections) and `.gitignore` (no data files in the repo).
- Run `npm run privacy` and `npm test` before publishing any change.
- `samples/` contains FAKE data only. Never put real statements in this repo.

## Publishing

`.github/workflows/pages.yml` runs the tests and the privacy check on every push, and on the default branch it publishes `_site/`
(built by `scripts/build-site.sh`: the app plus the made-up statements in `samples/`) to GitHub Pages.

One-time setup on GitHub: Settings > Pages > Build and deployment > Source: **GitHub Actions**. Free Pages needs a public repository,
which is fine here: it holds only code and made-up data.

The free address (`username.github.io`) is a single storage space shared by every page under that username, so use it with made-up
data only (the app shows a warning there). Real statements go on your own domain, on its own subdomain.

`SITE_DIR=_site E2E_PREFIX=/your-repo-name/ npm run e2e` runs the browser test against the assembled site, served under a subfolder the
way GitHub serves it. `test-files.html` in the published site is for trying the importers on a device and can be removed later.
