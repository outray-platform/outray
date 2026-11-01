# Public edge deployment

This repository's release pipeline builds the tunnel edge, CLI and SDKs. Deployment scripts manage only the edge and its gateway routing, not unrelated services or database migrations.

`Dockerfile` builds the edge image. The GitHub image workflow publishes `ghcr.io/outray-platform/outray-edge:<full-source-commit>` for amd64/arm64. Deployment pipelines pin the immutable registry digest and verify the OCI revision label.

The hosted VPS promotion is a manual Woodpecker step on `main`, using `edge_ssh_key`. `deploy/woodpecker/deploy-edge.sh` uploads a unique `/root/outray-edge/releases/<commit>-<id>` artifact and holds `/var/lock/outray-deployment.lock` during promotion. All deployers sharing the host must respect this lock and use separate artifact directories. Existing edge runtime settings are retained from the active PM2 edge.

The blue/green deployment preserves the authenticated control-plane API, status forwarding, Redis queues and accounting adapters.

For local edge development, configure `.env.example` against a compatible control plane.
