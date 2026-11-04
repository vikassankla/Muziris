# The application's images.
#
# For local testing in Docker (docker-compose.yml, profile "app"), with dev dependencies:
#   api       the admin and storefront API, and the CLI commands (migrations, setup, admin:create)
#   web       nginx serving the built admin app and storefront, proxying their API paths to api
#
# For the pilot install (deploy/compose.yml, ADR 0029):
#   api-prod  the API with production dependencies only, still run from its TypeScript sources
#             with tsx
#   edge      Caddy serving the built apps over HTTPS, proxying their API paths to api-prod

FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app
# Fetch packages from the lockfile alone, so this layer survives source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install && pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline

FROM deps AS api
ENV NODE_ENV=development HOST=0.0.0.0 PORT=4000
USER node
EXPOSE 4000
CMD ["pnpm", "--filter", "@muziris/api", "start"]

FROM deps AS web-build
# The storefront serves one website, chosen at build time (apps/storefront, ADR 0015).
ARG VITE_STOREFRONT_WEBSITE=main
ENV VITE_STOREFRONT_WEBSITE=${VITE_STOREFRONT_WEBSITE}
RUN pnpm --filter @muziris/admin build && pnpm --filter @muziris/storefront build

FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/app-headers.conf /etc/nginx/snippets/app-headers.conf
COPY --from=web-build /app/apps/admin/dist /srv/admin
COPY --from=web-build /app/apps/storefront/dist /srv/storefront
EXPOSE 8080 8081

FROM deps AS api-deploy
# The API with its workspace packages and production dependencies only. The storefront's
# persisted queries are the only operations production runs (ADR 0014).
RUN pnpm --filter @muziris/api deploy --prod --legacy --offline /out \
  && cp apps/storefront/persisted-queries.json /out/persisted-queries.json

FROM node:22-alpine AS api-prod
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000 \
  STOREFRONT_PERSISTED_QUERIES=/app/persisted-queries.json \
  PATH=/app/node_modules/.bin:$PATH
WORKDIR /app
# Owned by root, so the API cannot change its own code.
COPY --from=api-deploy /out ./
USER node
EXPOSE 4000
CMD ["tsx", "src/server.ts"]

FROM caddy:2.11.7-alpine AS edge
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/apps/admin/dist /srv/admin
COPY --from=web-build /app/apps/storefront/dist /srv/storefront
