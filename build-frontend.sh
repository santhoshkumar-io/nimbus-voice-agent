#!/usr/bin/env bash
# Build a deployable copy of the frontend into dist/.
#
# Why this exists: the site lives in nimbus-voice-agent-starter/ and reaches the
# playground through a SYMLINK (nimbus-voice-agent-starter/playground -> ../playground).
# Vercel does not follow it, so deploying the directory directly publishes the
# site without any playground pages. This dereferences it.
set -euo pipefail
cd "$(dirname "$0")"

OUT="dist"
rm -rf "$OUT"
mkdir -p "$OUT"

# -L dereferences symlinks, so playground/ lands as real files.
cp -RL nimbus-voice-agent-starter/. "$OUT"/

# Repo-only files that should not be published.
rm -f "$OUT/.gitignore" "$OUT/README.md"

# Sanity: the playground must be real files, not a link, and must be populated.
[ -L "$OUT/playground" ] && { echo "ERROR: playground is still a symlink"; exit 1; }
for f in index.html assets/widget.js assets/s2s.js playground/voice.html \
         playground/voice.js playground/s2s.js playground/runtime-config.js; do
  [ -f "$OUT/$f" ] || { echo "ERROR: missing $f in $OUT"; exit 1; }
done

echo "built $OUT/ ($(find "$OUT" -type f | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1))"
echo
echo "Deploy with:"
echo "  cd $(pwd)/$OUT && vercel deploy --prod"
