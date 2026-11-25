# syntax=docker/dockerfile:1
FROM node:20.19.5-bookworm-slim@sha256:9e70124bd00f47dd023e349cd587132ae61892acc0e47ed641416c3e18f401c3
# git: the desk commits every accepted proof to lean/Proofs/ in the mounted checkout.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* \
 && git config --system safe.directory /repo \
 && npm install -g pnpm@9.15.9
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/desk/package.json apps/desk/
RUN pnpm install --frozen-lockfile --prod --filter @hatchery/desk...
COPY packages/shared/src packages/shared/src
COPY apps/desk/src apps/desk/src
COPY apps/desk/drizzle apps/desk/drizzle
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4200 LEAN_DIR=/repo/lean
WORKDIR /app/apps/desk
USER node
EXPOSE 4200
CMD ["node", "--import", "tsx", "src/main.ts"]
