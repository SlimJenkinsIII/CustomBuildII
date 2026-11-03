#!/usr/bin/env bash
# Fails if the privacy rules have been weakened. Run before publishing: bash scripts/check-privacy.sh
set -u
fail=0
html=app/index.html

grep -q "connect-src 'none'" "$html" || { echo "FAIL: connect-src 'none' missing from $html"; fail=1; }
grep -q "default-src 'self'" "$html" || { echo "FAIL: default-src 'self' missing from $html"; fail=1; }

# No outside code or resources anywhere in the app
# (The SVG namespace is an identifier the browser needs to draw charts, not an address anything contacts.)
if grep -rEn "https?://" app --include=*.html --include=*.js --include=*.css | grep -v "Content-Security-Policy" | grep -v "http://www.w3.org/2000/svg'"; then
  echo "FAIL: app references an outside web address (above)"; fail=1
fi
# No network calls in app code
if grep -rEn "fetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts" app/src; then
  echo "FAIL: app code makes or could make network calls (above)"; fail=1
fi
# No data files tracked by git outside samples/
bad=$(git ls-files | grep -Ei '\.(csv|ofx|qfx|pdf|xlsx|db|sqlite3?|enc|backup)$' | grep -v '^samples/FAKE-')
if [ -n "$bad" ]; then echo "FAIL: data-like files are tracked:"; echo "$bad"; fail=1; fi

[ $fail -eq 0 ] && echo "Privacy checks passed."
exit $fail
