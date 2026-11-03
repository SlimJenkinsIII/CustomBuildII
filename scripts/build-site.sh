#!/usr/bin/env bash
# Assembles exactly what gets published, into _site/. The publish workflow and the local test both use this.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf _site
mkdir -p _site/samples
cp -r app/. _site/
cp samples/FAKE-*.csv _site/samples/        # made-up statements, for trying the importers on a device
touch _site/.nojekyll
echo "Built _site with $(find _site -type f | wc -l) files."
