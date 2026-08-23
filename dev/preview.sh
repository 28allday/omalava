#!/bin/bash
# Run the lamp in a floating window without touching the live shell.
#
# quickshell will not load files outside its config folder, so this stages a
# copy of Lamp.qml, the shaders and preview.qml into a temp dir and runs qs
# there. Extra args go to qs (e.g. nothing, or -n). Env knobs: see preview.qml.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
stage=$(mktemp -d -t omalava-preview.XXXXXX)
trap 'rm -rf "$stage"' EXIT
cp "$root/Lamp.qml" "$root/Sim.js" "$here/preview.qml" "$stage/"
cp -r "$root/shaders" "$stage/shaders"
exec qs -p "$stage/preview.qml" "$@"
