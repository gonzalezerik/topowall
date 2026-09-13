#!/usr/bin/env bash
# Regenerate web/studio/presets.json from the CLI's built-in themes and palettes,
# so the studio's presets are exactly what `topowall render` produces.
#
#   cargo build --release && scripts/web-presets.sh
set -euo pipefail
cd "$(dirname "$0")/.."
TOPOWALL=${TOPOWALL:-target/release/topowall}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

THEMES=(graphite 3e5d58-92aca0 3f5875-87abc0 hypsometric)
PALETTES=(solarized-dark rose-pine catppuccin-mocha nord gruvbox-dark dracula tokyo-night-dark everforest-dark-medium kanagawa)

for t in "${THEMES[@]}"; do
  cp "themes/$t.toml" "$TMP/theme--$t.toml"
done
for p in "${PALETTES[@]}"; do
  for style in subtle vivid; do
    "$TOPOWALL" theme --palette "$p" --style "$style" -o "$TMP/palette--$p--$style.toml"
  done
done

python3 - "$TMP" > web/studio/presets.json <<'PY'
import json, pathlib, sys, tomllib
out = []
for f in sorted(pathlib.Path(sys.argv[1]).glob("*.toml")):
    kind, *rest = f.stem.split("--")
    theme = tomllib.loads(f.read_text())
    out.append({"id": f.stem, "group": "Themes" if kind == "theme" else "Palettes",
                "label": theme.get("name", rest[0]), "theme": theme})
order = {"Themes": 0, "Palettes": 1}
out.sort(key=lambda p: (order[p["group"]], p["id"]))
json.dump(out, sys.stdout, indent=1, ensure_ascii=False)
PY
echo "wrote web/studio/presets.json ($(grep -c '"id"' web/studio/presets.json) presets)" >&2
