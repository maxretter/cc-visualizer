#!/usr/bin/env bash
# Records `/viz demo` in a real Claude Code session and renders it as the
# README's GIF. Needs claude, python3 (with venv) and ffmpeg; pyte and Pillow
# are installed into a throwaway virtualenv, at the versions and hashes
# requirements.txt pins.
#
# usage: scripts/demo-gif/make.sh [OUT.gif]   (default: docs/demo.gif)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="$(realpath -m "${1:-$repo/docs/demo.gif}")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

python3 -m venv "$work/venv"
"$work/venv/bin/pip" install --quiet --disable-pip-version-check --require-hashes --only-binary :all: -r "$here/requirements.txt"

python3 -I "$here/record.py" "$work/demo.cast"
mkdir -p "$(dirname "$out")"
"$work/venv/bin/python" -I "$here/render.py" "$work/demo.cast" "$out"
