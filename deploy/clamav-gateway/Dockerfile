# ClamAV plus the gateway in one machine.
#
# One container rather than two because clamd must be reachable only on
# loopback: the gateway is the authenticated front door, and a separately
# addressable clamd would be an unauthenticated one sitting beside it.
FROM clamav:1.4

# Node for the gateway. The ClamAV image is Alpine-based.
RUN apk add --no-cache nodejs

COPY server.mjs /opt/gateway/server.mjs
COPY entrypoint.sh /opt/gateway/entrypoint.sh
RUN chmod +x /opt/gateway/entrypoint.sh

# The signature database lives on a mounted volume so an update survives a
# restart; without it every deploy re-downloads ~1 GB.
VOLUME ["/var/lib/clamav"]

ENV PORT=8080 CLAMD_HOST=127.0.0.1 CLAMD_PORT=3310
EXPOSE 8080

ENTRYPOINT ["/opt/gateway/entrypoint.sh"]
