#!/bin/bash
# Bundles the composer engine against the web app's installed packages, so a web dependency bump
# followed by a rebuild keeps the two in step. Needs `npm install` to have run in
# genai-react-app, and esbuild, by default from component-library.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WEB_MODULES="$REPO/genai-react-app/node_modules"
ESBUILD="${ESBUILD:-$REPO/../component-library/node_modules/.bin/esbuild}"
OUT="$HERE/../../AI Wrapper/Assets.xcassets/composerengine.dataset/composer-engine.min.js"

NODE_PATH="$WEB_MODULES" "$ESBUILD" "$HERE/entry.js" \
  --bundle \
  --minify \
  --format=iife \
  --platform=neutral \
  --main-fields=module,main \
  --conditions=import \
  --target=es2020 \
  --legal-comments=none \
  --charset=utf8 \
  --outfile="$OUT"
