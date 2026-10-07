#!/bin/sh
# Starts the ClamAV image's own init alongside the gateway.
#
# The base image's entrypoint is `/init`. It patches clamd.conf and
# freshclam.conf from `CLAMD_CONF_*` / `FRESHCLAM_CONF_*` environment
# variables, downloads the signature database if the volume is empty, starts
# `clamd --foreground &`, starts the `freshclam` daemon unless
# CLAMAV_NO_FRESHCLAMD=true, waits for clamd's socket, and then blocks on
# `tail -f /dev/null`.
#
# So clamd's listen address is configured through the environment in fly.toml,
# NOT by sed-ing the config here — an earlier version of this file did that, and
# it fought the entrypoint that was about to rewrite the same file.
#
# POSIX sh only. This image's /bin/sh is dash, which has no `wait -n`; an
# earlier version used it and would have failed at startup on the one path that
# matters, the supervision loop.
set -eu

if [ -z "${SCANNER_TOKEN:-}" ]; then
  echo "SCANNER_TOKEN is not set; refusing to start an unauthenticated scanner" >&2
  exit 1
fi

/init &
INIT_PID=$!

node /opt/gateway/server.mjs &
GATEWAY_PID=$!

# If either dies the machine should stop rather than serve half a service. A
# gateway with no clamd returns 502, which refuses uploads — correct, but it
# must not be a steady state, and Fly restarts a machine whose process exits.
while :; do
  if ! kill -0 "$INIT_PID" 2>/dev/null; then
    echo "clamav init exited; stopping so the platform restarts the machine" >&2
    kill "$GATEWAY_PID" 2>/dev/null || true
    exit 1
  fi
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    echo "gateway exited; stopping so the platform restarts the machine" >&2
    kill "$INIT_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 5
done
