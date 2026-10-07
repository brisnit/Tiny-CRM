# ClamAV plus the gateway in one machine.
#
# One container rather than two because clamd must be reachable only on
# loopback: the gateway is the authenticated front door, and a separately
# addressable clamd would be an unauthenticated one sitting beside it.
#
# `clamav/clamav`, not `clamav`. There is no `library/clamav` on Docker Hub — a
# first version of this file said `FROM clamav:1.4` and would have failed to
# pull. And every current tag is **Debian**-based; the Alpine variants are gone,
# so this uses apt rather than apk. Both errors were found by querying the
# registry before deploying rather than by watching a build fail.
#
# The `-debian13-slim` variant over plain `-debian`: same ClamAV, smaller image,
# and nothing here needs the extras.
FROM clamav/clamav:1.5.4-debian13-slim

# Node for the gateway. The gateway uses only long-stable core modules — http,
# net, fs/promises, crypto, path — so whatever Debian ships is new enough.
RUN apt-get update \
 && apt-get install --no-install-recommends -y nodejs \
 && rm -rf /var/lib/apt/lists/*

COPY server.mjs /opt/gateway/server.mjs
COPY entrypoint.sh /opt/gateway/entrypoint.sh
RUN chmod +x /opt/gateway/entrypoint.sh

# The signature database lives on a mounted volume so an update survives a
# restart; without it every deploy re-downloads ~1 GB and hammers the mirrors.
VOLUME ["/var/lib/clamav"]

ENV PORT=8080 CLAMD_HOST=127.0.0.1 CLAMD_PORT=3310
EXPOSE 8080

ENTRYPOINT ["/opt/gateway/entrypoint.sh"]
