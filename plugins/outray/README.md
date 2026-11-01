# OutRay plugin

Connect OutRay to Codex and ChatGPT to work with your tunnels, observability, uptime and Secrets.

## Capabilities

- [Tunnels](skills/tunnels/SKILL.md) — expose local apps and test webhooks.
- [Observability](skills/observability/SKILL.md) — configure SDKs and investigate requests, traces and logs.
- [Secrets](skills/secrets/SKILL.md) — manage vault metadata and inject configuration into local commands without displaying secret values.
- [Administration](skills/administration/SKILL.md) — manage organizations, uptime monitors, status pages and incidents.

## Authentication

The plugin connects to `https://outray.co/api/mcp/openai` using OAuth and respects your OutRay organization permissions. It does not expose secret values or authentication credentials, and it does not make purchases or change subscriptions.

Local workflows require local command execution. Authenticate the CLI separately with `outray login` when using those workflows.

## Development

From the repository root:

```sh
npm run plugin:check
npm run plugin:package
```

The archive is written to `dist/plugins/`. Validation checks the manifest, skills, icons and OAuth configuration, and rejects credentials and account-specific bindings.

For the native development helper's options, run `npm run plugin:prepare:native -- --help`.
