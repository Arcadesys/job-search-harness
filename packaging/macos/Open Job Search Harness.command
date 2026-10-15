#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
./node ./app/packaging/macos/open.mjs
echo
read -r -p "Press Return to close this window..." _
