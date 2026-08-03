# Build context is the repo root:  docker build -f apps/web/Dockerfile .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @speakukrainian/web... --filter @speakukrainian/shared...

FROM deps AS build
COPY tsconfig.base.json turbo.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @speakukrainian/shared build \
 && pnpm --filter @speakukrainian/web build

# ---- runtime ----------------------------------------------------------------
# The Angular SSR bundle is self-contained: `ng build` bundles the server code
# and its dependencies, so the runtime image needs no node_modules at all.
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

COPY --from=build /repo/apps/web/dist/web ./

RUN useradd --system --create-home --uid 10001 nodeapp && chown -R nodeapp:nodeapp /app
USER nodeapp

EXPOSE 8080
CMD ["node", "server/server.mjs"]
