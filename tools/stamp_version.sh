#!/bin/sh
# version.js にビルド番号（次のコミットで何個目か）と時刻を書いて、コミットに入れる。
# コミットの前に流す: sh tools/stamp_version.sh && git commit ...
cd "$(git rev-parse --show-toplevel)" || exit 1
n=$(( $(git rev-list --count HEAD 2>/dev/null || echo 0) + 1 ))
t=$(date '+%Y-%m-%d %H:%M')  # PC の時刻（日本時間）
printf '// tools/stamp_version.sh が書く（コミットの前に更新）\nwindow.SIRO_BUILD = { n: %d, time: "%s" };\n' "$n" "$t" > version.js
git add version.js
