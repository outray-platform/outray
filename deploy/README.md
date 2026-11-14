# Public edge deployment

This repository's release pipeline builds the tunnel edge, CLI and SDKs. Deployment scripts manage only the edge and its gateway routing, not unrelated services or database migrations.

`Dockerfile` builds the edge image. The GitHub image workflow publishes `ghcr.io/outray-platform/outray-edge:<full-source-commit>` for amd64/arm64. Deployment pipelines pin the immutable registry digest and verify the OCI revision label.

Every push to `main` automatically promotes the hosted VPS edge after the Woodpecker install, build, and test steps pass. Manual reruns remain available on `main`; pull requests and other branches do not receive deployment credentials or deploy. The existing `edge_ssh_key` repository secret must allow **Push** and **Manual** events, with pull-request exposure disabled.

`deploy/woodpecker/deploy-edge.sh` uploads a unique `/root/outray-edge/releases/<commit>-<id>` artifact and holds `/var/lock/outray-deployment.lock` during promotion. All deployers sharing the host must respect this lock and use separate artifact directories. Existing edge runtime settings are retained from the active PM2 edge. Deployment starts the inactive slot and checks its health before switching Caddy; the old process is retired after the switch, so long-lived connections may reconnect.

The blue/green deployment preserves the authenticated control-plane API, status forwarding, Redis queues and accounting adapters.

For local edge development, configure `.env.example` against a compatible control plane.

## Guest HTTP tunnels

Guest sessions have a fixed 60-minute deadline, one active tunnel per IP, and five admitted starts per minute. Redis makes admission atomic across edge instances; guest creation fails closed when Redis is unavailable. Routing and active-slot leases cannot outlive the deadline, and expired sockets stop forwarding HTTP and WebSocket traffic.

Guest limits use the TCP peer address unless that peer is in `TUNNEL_TRUSTED_PROXY_IPS` (comma-separated exact IPs). Defaults are loopback; Ops can reuse its existing `STATUS_TRUSTED_PROXY_IPS`. Only configure proxies that sanitize forwarding headers. The edge uses the rightmost `X-Forwarded-For` hop from a trusted peer, consistent with [Caddy's forwarding-header behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers).

Install `redis-server` on the test runner to exercise all Redis-backed regressions in `npm test --workspace=outray-tunnel`; tests launch isolated socket-only instances and never use deployment Redis settings.
