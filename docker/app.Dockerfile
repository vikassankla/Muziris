# The application for local testing in Docker (docker-compose.yml, profile "app"). Not a
# production image: it keeps dev dependencies and runs the TypeScript sources with tsx, as
# `pnpm --filter @muziris/api start` does.
#
# Targets:
#   api  the admin and storefront API, and the CLI commands (migrations, setup, admin:create)
#   web  nginx serving the built admin app and storefront, proxying their API paths to api

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
COPY --from=web-build /app/apps/admin/dist /srv/admin
COPY --from=web-build /app/apps/storefront/dist /srv/storefront
EXPOSE 8080 8081
