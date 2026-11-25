# syntax=docker/dockerfile:1
# Judge HTTP service. It runs NO untrusted code itself: it starts one fresh, locked-down
# runner container per stage through the host Docker socket (see docs/judge.md for the trade-off).
FROM docker:27.5.1-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c AS dockercli

FROM node:20.19.5-bookworm-slim@sha256:9e70124bd00f47dd023e349cd587132ae61892acc0e47ed641416c3e18f401c3
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
RUN npm install -g pnpm@9.15.9
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/judge/package.json apps/judge/
RUN pnpm install --frozen-lockfile --prod --filter @hatchery/judge...
COPY packages/shared/src packages/shared/src
COPY apps/judge/src apps/judge/src
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4100
WORKDIR /app/apps/judge
EXPOSE 4100
CMD ["node", "--import", "tsx", "src/main.ts"]
