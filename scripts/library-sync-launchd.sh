#!/bin/bash
# launchd entrypoint for the nightly WatchTime library sync.
#
# Invoked by launchd via scripts-and-agents/scripts/launchd_wrapper.sh
# (job label: watchtime-library-sync), which handles logging, Slack
# notifications, retries, and timeout -- this script only needs to get
# `node scripts/library-sync.mjs` running with the right PATH/cwd.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# node on this machine is managed by Hermes and not on launchd's bare PATH --
# resolve it via the stable ~/.local/bin/node symlink (which tracks Hermes
# internals) rather than hardcoding Hermes's private layout.
# (yt-dlp/ffmpeg PATH is handled inside library-sync.mjs itself.)
NODE_BIN="$HOME/.local/bin/node"

exec "$NODE_BIN" scripts/library-sync.mjs "$@"
