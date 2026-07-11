#!/usr/bin/env bash
# Fills www/ (Capacitor's webDir) from the repo's web assets.
# www/ is generated — never edit it, never commit it.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf www
mkdir -p www/icons
cp index.html www/
cp icons/*.png www/icons/
