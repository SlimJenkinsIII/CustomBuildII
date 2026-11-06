#!/usr/bin/env bash
# Assembles exactly what gets published, into _site/. The publish workflow and the local test both use this.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf _site
mkdir -p _site/samples
cp -r app/. _site/
cp samples/FAKE-*.csv _site/samples/        # made-up statements, for trying the importers on a device
# stamp the build, so Settings can show which version a device is running
BUILD="$(echo "${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo dev)}" | cut -c1-7)"
sed -i "s|<meta name=\"app-build\" content=\"dev\">|<meta name=\"app-build\" content=\"$BUILD\">|" _site/index.html
touch _site/.nojekyll
echo "Built _site with $(find _site -type f | wc -l) files."
