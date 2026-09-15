#!/usr/bin/env bash
# Regenerate the browser app's data from the command-line app, so the web and
# `topowall render` agree:
#   web/app/data/themes.json            built-in themes (themes/*.toml)
#   web/app/data/palettes.json          copy of crates/kit/palettes/palettes.json
#   web/test/fixtures/palette-themes.json  `topowall theme` output for every scheme (web tests)
#
#   cargo build --release && scripts/web-presets.sh
set -euo pipefail
cd "$(dirname "$0")/.."
TOPOWALL=${TOPOWALL:-target/release/topowall}
mkdir -p web/app/data web/test/fixtures

cp crates/kit/palettes/palettes.json web/app/data/palettes.json

python3 - "$TOPOWALL" <<'PY'
import json, pathlib, subprocess, sys, tomllib
topowall = sys.argv[1]

order = ["3e5d58-92aca0", "3f5875-87abc0", "graphite", "hypsometric"]
themes = sorted(pathlib.Path("themes").glob("*.toml"), key=lambda f: (order.index(f.stem) if f.stem in order else 99, f.stem))
out = [{"id": f.stem, "theme": tomllib.loads(f.read_text())} for f in themes]
pathlib.Path("web/app/data/themes.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")

catalog = json.loads(pathlib.Path("crates/kit/palettes/palettes.json").read_text())["palettes"]
fixture = {}
for p in catalog:
    for style, bg in [("subtle", "palette"), ("vivid", "palette"), ("mono", "palette"), ("subtle", "black")]:
        t = tomllib.loads(subprocess.run([topowall, "theme", "--palette", p["name"], "--style", style, "--background", bg],
                                         capture_output=True, text=True, check=True).stdout)
        fixture[f"{p['name']}|{style}|{bg}"] = [t["background"], t["lines"][0]["color"], t["lines"][1]["color"]]
pathlib.Path("web/test/fixtures/palette-themes.json").write_text(json.dumps(fixture, separators=(",", ":")) + "\n")
print(f"wrote {len(out)} themes and {len(fixture)} palette fixtures", file=sys.stderr)
PY
