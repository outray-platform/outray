# Contributing to OutRay tools

Target `main`. Use Node.js >=22.19.0, run `npm ci`, build and run the affected package tests. Run the full public build and tests before a release.

Keep shared HTTP capture and redaction policy in `@outray/core`, tracing/export behavior in `@outray/observability`, and reusable server primitives in `@outray/runtime-shared`. Framework adapters only adapt lifecycle/context. Workspaces must build independently using their declared dependencies.

Never include credentials, production environment files or real secret values in changes or test fixtures. Preserve authentication, tenant isolation, protocol compatibility and payload-redaction checks.
