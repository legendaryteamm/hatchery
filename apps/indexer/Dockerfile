# syntax=docker/dockerfile:1
FROM node:20.19.5-bookworm-slim@sha256:9e70124bd00f47dd023e349cd587132ae61892acc0e47ed641416c3e18f401c3
RUN npm install -g pnpm@9.15.9
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/indexer/package.json apps/indexer/
RUN pnpm install --frozen-lockfile --prod --filter @hatchery/indexer...
COPY packages/shared/src packages/shared/src
COPY apps/indexer/src apps/indexer/src
ENV NODE_ENV=production
WORKDIR /app/apps/indexer
USER node
CMD ["node", "--import", "tsx", "src/main.ts"]
