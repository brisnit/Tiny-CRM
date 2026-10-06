#!/bin/sh
# clamd and freshclam are started by the base image's own init, which also
# waits for the first signature download before clamd accepts connections.
# The gateway is started alongside it and reports staleness on /health.
set -e

if [ -z "$SCANNER_TOKEN" ]; then
  echo "SCANNER_TOKEN is not set; refusing to start an unauthenticated scanner" >&2
  exit 1
fi

# Bind clamd to loopback only. The gateway is the sole route in.
sed -i 's/^#\?TCPAddr .*/TCPAddr 127.0.0.1/' /etc/clamav/clamd.conf || true

/init &
INIT_PID=$!

node /opt/gateway/server.mjs &
GATEWAY_PID=$!

# If either dies, the machine should restart rather than serve half a service:
# a gateway with no clamd returns 502, which refuses uploads — correct, but it
# should not be a steady state.
wait -n "$INIT_PID" "$GATEWAY_PID"
echo "a component exited; stopping so the platform restarts the machine" >&2
exit 1
