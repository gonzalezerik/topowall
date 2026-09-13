#!/usr/bin/env bash
# Regenerate the README gallery: five US national parks rendered with five
# color styles.
#
#   cargo build --release && scripts/gallery.sh
#
# Output: docs/gallery/<park>/<style>.jpg
set -euo pipefail

cd "$(dirname "$0")/.."
TOPOWALL=${TOPOWALL:-target/release/topowall}
OUT=docs/gallery
SIZE=1200x750
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# slug | centre (lat,lon) | width (km) — framed on each park's best-known terrain
PARKS=(
  "great-smoky-mountains|35.610,-83.470|24"   # Mount Le Conte and Clingmans Dome
  "zion|37.255,-112.955|14"                   # Zion Canyon and Angels Landing
  "yellowstone|44.750,-110.470|24"            # Grand Canyon of the Yellowstone and Mount Washburn
  "grand-canyon|36.120,-112.080|24"           # The inner canyon north of Grand Canyon Village
  "yosemite|37.738,-119.575|18"               # Yosemite Valley, El Capitan to Half Dome
)

# file name | render arguments
STYLES=(
  "solarized-dark|--palette solarized-dark"
  "rose-pine|--palette rose-pine"
  "catppuccin-mocha|--palette catppuccin-mocha"
  "3f5875-87abc0|--theme 3f5875-87abc0"
  "3e5d58-92aca0|--theme 3e5d58-92aca0"
)

for park in "${PARKS[@]}"; do
  IFS='|' read -r slug center width <<<"$park"
  mkdir -p "$OUT/$slug"
  # Smooth over ~2.5 output pixels so lines flow at this image size.
  smooth=$(awk -v w="$width" -v s="${SIZE%x*}" 'BEGIN { printf "%.1f", w * 1000 / s * 2.5 }')
  "$TOPOWALL" fetch --center "$center" --width-km "$width" --size "$SIZE" --smooth-m "$smooth" -o "$TMP/$slug.topo"
  for style in "${STYLES[@]}"; do
    IFS='|' read -r name args <<<"$style"
    # shellcheck disable=SC2086
    "$TOPOWALL" render "$TMP/$slug.topo" $args --interval auto --quality 82 -o "$OUT/$slug/$name.jpg"
  done
done
