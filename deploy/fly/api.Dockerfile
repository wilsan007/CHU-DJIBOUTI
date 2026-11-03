# Noyau applicatif (Node 22 exécute le TypeScript directement). Contexte de construction : la racine du dépôt.
ARG NODE_IMAGE=node:22-slim
FROM ${NODE_IMAGE}
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY services/api ./services/api
COPY tools ./tools
RUN pnpm install --frozen-lockfile --prod --filter @chu/api...
USER node
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
WORKDIR /app/services/api
CMD ["node", "src/server.ts"]
