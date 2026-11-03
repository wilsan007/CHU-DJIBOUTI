# Point d'entrée public : Nginx + portail construit. HTTPS est terminé par Fly (le certificat est géré par Fly) ;
# Nginx écoute en HTTP interne et fait confiance à X-Forwarded-Proto de Fly.
ARG NODE_IMAGE=node:22-slim
FROM ${NODE_IMAGE} AS build
RUN corepack enable
WORKDIR /app
ARG VITE_OIDC_AUTHORITY
ARG VITE_ENV_BANNER=""
ENV VITE_OIDC_AUTHORITY=$VITE_OIDC_AUTHORITY VITE_ENV_BANNER=$VITE_ENV_BANNER
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/portal ./apps/portal
COPY tools ./tools
COPY services/api/package.json ./services/api/package.json
RUN pnpm install --frozen-lockfile --filter @chu/portal... && pnpm --filter @chu/portal build

ARG NGINX_IMAGE=nginx:1.27
FROM ${NGINX_IMAGE}
COPY --from=build /app/apps/portal/dist /usr/share/nginx/html
COPY deploy/fly/nginx.fly.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
