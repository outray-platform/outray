# OutRay public repository

This MIT repository contains only the tunnel edge, CLI, public SDKs, runtime primitives and client plugin. The console and product backend are maintained separately in `outray-platform/platform` on `next`.

Read `packages/AGENTS.md`. Preserve public package names, SDK exports and HTTP/TCP/UDP/WebSocket wire compatibility. Use published dependency boundaries; never copy private platform implementations into this repository. Production credentials are not build dependencies. Edge deployment must never deploy internal-check, probe, cron or database migrations.
