#!/bin/sh
# Assemble the browser app into one static folder, ready for any web server:
#
#   scripts/web-dist.sh OUT_DIR
#
# OUT_DIR gets index.html, the app's scripts and styles, its data and licenses.
# Every path inside is relative, so the folder can be served at any URL path.
set -eu
cd "$(dirname "$0")/.."
out=${1:?usage: scripts/web-dist.sh OUT_DIR}

rm -rf "$out"
mkdir -p "$out/src" "$out/data"
cp web/app/index.html web/app/app.css web/app/favicon.svg "$out/"
# The app imports ../src/ in the repository layout; in the folder, src/ sits next to it.
sed 's#"\.\./src/#"./src/#g' web/app/app.js > "$out/app.js"
for f in color.js color-picker.js geocode.js palette.js png.js renderer-webgl.js terrain.js theme.js topo.js; do
  cp "web/src/$f" "$out/src/"
done
cp web/app/data/themes.json "$out/data/"
cp crates/kit/palettes/palettes.json "$out/data/palettes.json"
cp LICENSE "$out/LICENSE.txt"
cp crates/kit/palettes/LICENSE-tinted-theming "$out/LICENSE-tinted-theming.txt"

# Fail if anything still points outside the folder.
if grep -rn '"\.\./' "$out" --include='*.js' --include='*.html'; then
  echo "web-dist: found imports outside $out" >&2
  exit 1
fi
echo "web-dist: $out ($(du -sh "$out" | cut -f1))"
