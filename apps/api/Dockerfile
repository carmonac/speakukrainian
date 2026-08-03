# Build context is the repo root, so the workspace and the shared package are
# both available:  docker build -f apps/api/Dockerfile .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Without CI, pnpm refuses to purge node_modules non-interactively.
ENV CI=true
RUN corepack enable
WORKDIR /repo

# ---- dependencies -----------------------------------------------------------
# Copying only the manifests first means a source-only change reuses this layer.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @speakukrainian/api... --filter @speakukrainian/shared...

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json turbo.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @speakukrainian/shared build \
 && pnpm --filter @speakukrainian/api build

# `pnpm deploy` collects the app plus its production dependencies into a single
# self-contained directory. `--legacy` flattens the symlink tree, which matters
# because the runtime stage copies the directory out and symlinks pointing
# outside it would dangle.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm deploy --filter @speakukrainian/api --prod --legacy /app

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# Cloud Run overrides PORT; this is the fallback for a plain `docker run`.
ENV PORT=8080
WORKDIR /app

COPY --from=build /app ./

# Never run as root, and give the H5P working directory to that same user.
RUN useradd --system --create-home --uid 10001 nodeapp \
 && mkdir -p /app/h5p/temporary-storage \
 && chown -R nodeapp:nodeapp /app
USER nodeapp

EXPOSE 8080
CMD ["node", "dist/main.js"]
