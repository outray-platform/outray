# OutRay public repository

This MIT repository contains the tunnel edge, CLI, SDKs, runtime primitives and client plugin. Keep contributions scoped to these components.

Read `packages/AGENTS.md`. Preserve package names, SDK exports and HTTP/TCP/UDP/WebSocket wire compatibility. Workspaces must build independently using their declared dependencies. Production credentials are not build dependencies. Deployment scripts must manage only the tunnel edge and its gateway routing, not unrelated services or database migrations.
