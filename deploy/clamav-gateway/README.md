# ClamAV gateway — proposal

Not provisioned. See `docs/MALWARE-SCANNING.md` for the costed proposal, the
authentication model, and the verification steps that must pass **before** the
`files` flag is enabled for anyone.

- `server.mjs` — the HTTP front door. Its reply matches `readVerdict` in
  `src/lib/malware.ts` exactly: `{"Status":"OK"}` or
  `{"Status":"FOUND","Description":"…"}`, and nothing else.
- `Dockerfile` — ClamAV plus the gateway in one machine, so `clamd` is
  reachable only on loopback.
- `entrypoint.sh` — binds `clamd` to loopback, starts both, exits if either
  dies.
- `fly.toml` — one `shared-cpu-1x` / 2 GB machine in `sea` with a 3 GB volume.

Nothing in this directory is imported by the application or run by CI.
