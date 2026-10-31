# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY . .
RUN npm ci --workspace=outray-tunnel --workspace=@outray/runtime-shared --workspace=@outray/core --workspace=@outray/observability --include-workspace-root=false --include=dev --ignore-scripts --no-audit --no-fund
RUN npm run build --workspace=@outray/runtime-shared && npm run build --workspace=@outray/core && npm run build --workspace=@outray/observability && npm run build --workspace=outray-tunnel

FROM node:22-bookworm-slim
WORKDIR /app
ARG OUTRAY_SOURCE_COMMIT
LABEL org.opencontainers.image.source=https://github.com/outray-platform/outray
LABEL org.opencontainers.image.revision=${OUTRAY_SOURCE_COMMIT}
ENV NODE_ENV=production TUNNEL_BIND_HOST=0.0.0.0
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages/runtime-shared ./packages/runtime-shared
COPY --from=builder --chown=node:node /app/packages/core ./packages/core
COPY --from=builder --chown=node:node /app/packages/observability ./packages/observability
COPY --from=builder --chown=node:node /app/apps/tunnel/dist ./apps/tunnel/dist
USER node
EXPOSE 3547
CMD ["node", "apps/tunnel/dist/server.js"]
