# Image du noyau applicatif. Node exécute directement le TypeScript (aucune étape de compilation).
ARG NODE_IMAGE=node:22-slim
FROM ${NODE_IMAGE}
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY services/api ./services/api
RUN pnpm install --frozen-lockfile --prod --filter @chu/api...
USER node
ENV NODE_ENV=production
WORKDIR /app/services/api
EXPOSE 3000
CMD ["node", "src/server.ts"]
