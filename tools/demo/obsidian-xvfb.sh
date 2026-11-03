#!/bin/bash
# Obsidian for takes on headless Linux (OBSIDIAN_EXE); set OBSIDIAN_BIN when it is not /opt/obsidian/obsidian.
# A fresh profile would download an update and recreate the window under the harness: switch that off in it.
export DISPLAY="${DISPLAY:-:99}"
for arg in "$@"; do
	case "$arg" in
	--user-data-dir=*)
		file="${arg#--user-data-dir=}/obsidian.json"
		if [ -f "$file" ]; then
			python3 - "$file" <<'PY'
import json, sys

path = sys.argv[1]
data = json.load(open(path))
data["updateDisabled"] = True
json.dump(data, open(path, "w"))
PY
		fi
		;;
	esac
done
exec "${OBSIDIAN_BIN:-/opt/obsidian/obsidian}" --no-sandbox --disable-gpu "$@"
