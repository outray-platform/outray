# OutRay

Share your local server with a secure public URL. Test webhooks, preview your work, and connect to local services without opening ports on your router.

[Website](https://outray.co) · [Documentation](https://outray.co/docs)

## Get started

Install the CLI, sign in, and expose your local app:

```sh
npm install -g outray
outray login
outray 3000
```

OutRay gives you a public HTTPS address that forwards requests to `localhost:3000`. WebSocket connections are supported too.

For TCP and UDP services:

```sh
outray tcp 5432
outray udp 25565
```

## SDKs and integrations

Bring OutRay into your application or development workflow:

- [Core](packages/core/README.md) — programmatic tunnel client and shared HTTP capture utilities.
- [Observability](packages/observability/README.md) — Node.js traces, logs and metrics, built on OpenTelemetry.
- [Express](packages/express-plugin/README.md), [Hono](packages/hono/README.md), [NestJS](packages/nestjs-plugin/README.md), [Next.js](packages/next-plugin/README.md) and [TanStack Start](packages/tanstack-start/README.md) — framework integrations.
- [Vite](packages/vite-plugin) — integrate tunneling into your dev server.

The CLI also includes Secrets commands. See `outray secrets --help` for available workflows.

## Repository

- `apps/cli` — the `outray` command.
- `apps/tunnel` — the HTTP, TCP, UDP and WebSocket tunnel edge.
- `packages` — SDKs, framework integrations and shared runtime utilities.
- [`plugins/outray`](plugins/outray/README.md) — the OutRay MCP client plugin.

## Development

Use Node.js >=22.19.0 and npm >=10. Install and build:

```sh
npm ci
npm run build
npm test
```

To develop the tunnel edge locally, copy `.env.example` to `.env` and configure Redis and an authenticated control-plane API before running `npm run dev:tunnel`.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## License

MIT. Third-party notices and historical release licenses remain applicable to their respective code and versions.
