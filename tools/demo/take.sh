#!/bin/bash
# Films takes at full size and real speed, for cutting into a video: tools/demo/take.sh wizard changes merge
# Headless Linux: start `Xvfb :99 -screen 0 2560x1440x24 -nolisten tcp` first. Obsidian's trust dialog now and
# then swallows the first click, so a failed take runs again (up to three times).
set -u
cd "$(dirname "$0")/../.."
export DISPLAY="${DISPLAY:-:99}" DEMO_VIDEO=1 DEMO_WIDTH=1920 DEMO_SPEED=1
export OBSIDIAN_EXE="${OBSIDIAN_EXE:-$PWD/tools/demo/obsidian-xvfb.sh}"
for name in "$@"; do
	for attempt in 1 2 3; do
		# A crashed take leaves its Obsidian and relay behind; both live in directories with these names.
		pkill -f "mdsync-(e2e|relay)-"
		sleep 2
		timeout 420 pnpm exec jiti "tools/demo/$name.ts" && break
		echo "$name: attempt $attempt failed" >&2
	done
done
