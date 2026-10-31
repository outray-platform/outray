# OutRay open-source tools

MIT-licensed tunnel edge, CLI, SDKs and client integrations for OutRay.

- `apps/tunnel`: HTTP, TCP, UDP and WebSocket tunnel edge, including optional platform integration adapters.
- `apps/cli`: the `outray` command, including tunnel and Secrets client commands.
- `packages`: `@outray/core`, `@outray/observability`, Express, Hono, NestJS, Next.js, TanStack Start and Vite integrations, plus shared server primitives.
- `plugins/outray`: the public MCP client plugin; the MCP server is not part of this repository.

The hosted console and product backends live in the private [platform repository](https://github.com/outray-platform/platform/tree/next). The edge alone is not a complete control plane: it requires Redis and a compatible authenticated control-plane API. Authentication is not bypassed when running locally.

## Development

Use Node.js >=22.19.0 and npm >=10. Install and build:

```sh
npm ci
npm run build
npm test
```

Copy `.env.example` to `.env` and configure a compatible control plane before `npm run dev:tunnel`. No private source checkout or icon license is needed to build these tools. Standard hosted SDK and CLI defaults remain unchanged; integrations can explicitly configure a different base URL.

## Releases

`npm run packages:publish -- --all --dry-run` previews changed-package releases. Publishing uses `NPMJS_TOKEN`; never commit tokens or production environment files. CLI tag releases retain their existing binaries and installer formats. The independently built edge image is published as `ghcr.io/outray-platform/outray-edge` and should be pinned by digest in consumers.

See [CONTRIBUTING.md](CONTRIBUTING.md). Source in the current working tree is MIT-licensed; third-party notices and historical release licenses remain applicable to their respective code and versions.
