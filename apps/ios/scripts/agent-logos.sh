#!/usr/bin/env bash
# Rasterizes ah's vendored agent logos (the server's `web/public/logos`, provenance in `web/logos.tsx`)
# into Shared/AgentLogos.xcassets/Agents, at 2x and 3x of a 40 pt mark.
#
#   ./scripts/agent-logos.sh        # AH_SOURCE=<checkout> reads another ah's logos
#
# Single-color white marks become template images, so the app draws them in its own ink
# (as the web does on a light theme). Needs rsvg-convert and ImageMagick.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
src=${AH_SOURCE:-$root/../..}/web/public/logos
out=$root/Shared/AgentLogos.xcassets/Agents
[[ -d $src ]] || { echo "no logos at $src" >&2; exit 1; }

# key → file, as web/logos.tsx maps them.
declare -A FILE=(
  [claude]=claude.svg [codex]=openai.svg [gemini]=gemini.svg [grok]=grok.svg [muse]=meta.svg
  [hermes]=hermes-logo.png [opencode]=opencode.svg [cursor]=cursor.svg [copilot]=copilot.svg
  [crush]=crush.png [pi]=pi.svg [aider]=aider.png [amp]=amp.svg [auggie]=augment.svg
  [cline]=cline.svg [codebuff]=codebuff.png [droid]=factory.svg [goose]=goose.svg
  [jules]=jules.svg [kilocode]=kilocode.svg [kimi]=kimi.svg [kiro]=kiro.svg
  [openhands]=openhands.svg [plandex]=plandex.png [qwen]=qwen.svg
)
TEMPLATE=" codex grok cursor copilot pi cline goose kilocode kimi openhands auggie "

rm -rf "$out"
mkdir -p "$out"
printf '{\n  "info" : { "author" : "xcode", "version" : 1 },\n  "properties" : { "provides-namespace" : true }\n}\n' > "$out/Contents.json"
for key in $(printf '%s\n' "${!FILE[@]}" | sort); do
  file=$src/${FILE[$key]}
  set=$out/$key.imageset
  mkdir -p "$set"
  for scale in 2 3; do
    px=$((40 * scale))
    png=$set/$key@${scale}x.png
    if [[ $file == *.svg ]]; then
      rsvg-convert --keep-aspect-ratio -w $px -h $px "$file" -o "$png.tmp"
    else
      magick "$file" -resize ${px}x${px} "$png.tmp"
    fi
    # Square, centered, transparent around a mark that isn't.
    magick "$png.tmp" -background none -gravity center -extent ${px}x${px} -strip "$png"
    rm "$png.tmp"
  done
  intent=original
  [[ $TEMPLATE == *" $key "* ]] && intent=template
  cat > "$set/Contents.json" <<JSON
{
  "images" : [
    { "filename" : "$key@2x.png", "idiom" : "universal", "scale" : "2x" },
    { "filename" : "$key@3x.png", "idiom" : "universal", "scale" : "3x" }
  ],
  "info" : { "author" : "xcode", "version" : 1 },
  "properties" : { "template-rendering-intent" : "$intent" }
}
JSON
done
echo "$(ls -d "$out"/*.imageset | wc -l) logos in ${out#$root/}"
