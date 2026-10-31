# Public edge deployment

This repository owns only the tunnel edge and public client releases. It never deploys platform migrations, internal-check, cron, probes, or status renderers.

`Dockerfile` builds an independent edge image without private source or an icon license. The GitHub image workflow publishes `ghcr.io/outray-platform/outray-edge:<full-source-commit>` for amd64/arm64. Consumers must pin the immutable registry digest and verify the OCI revision label. Keep the package publicly readable for ordinary self-hosted installs.

The hosted VPS promotion is a manual Woodpecker step on public `main`, using only `edge_ssh_key`. `deploy/woodpecker/deploy-edge.sh` uploads a unique `/root/outray-edge/releases/<commit>-<id>` artifact and holds `/var/lock/outray-deployment.lock` during promotion. Private service deployment uses the same host lock and a different artifact root. Existing edge runtime settings are retained from the active PM2 edge; no private vault master keys, billing/email keys or Ops Secrets token are required by public CI.

The blue/green edge continues to use its existing authenticated console API, status-forwarding contract, Redis queue and accounting adapter. It manages the edge/Caddy route only. Cron stays independently hosted on Aeroplane; no edge deployment starts another cron process.

For local edge development configure `.env.example` against your own compatible control plane. Full-platform self-hosting requires private access and is documented in the platform repository on `next`.
