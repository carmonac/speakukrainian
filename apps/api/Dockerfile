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
COPY scripts/package.json scripts/
# The root `postinstall` fetches the H5P client libraries, and pnpm runs the
# root project's lifecycle scripts even under `--filter`. It skips when this
# file is not in the context — which is what lets the admin and web images
# install their subset of the workspace without it — so copying it here is how
# *this* image opts into the fetch, and it puts the download in this cached
# layer, which is what we want: the pinned commits change far less often than
# the sources do.
COPY scripts/fetch-h5p-core.ts scripts/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile \
      --filter @speakukrainian/api... \
      --filter @speakukrainian/shared... \
      --filter @speakukrainian/scripts

# ---- H5P client assets ------------------------------------------------------
# The postinstall above is deliberately soft-failing, so that `pnpm install` on
# a machine with no network still succeeds. An *image* that cannot serve the
# H5P client is broken rather than inconvenient, and nobody reads a build's
# warnings — so this stage runs the same script with `--require`, which turns
# the offline case into a non-zero exit. When the assets are already there from
# the layer above it is a no-op.
#
# It is also what stands between this image and a *silently* skipped fetch: drop
# the COPY above and the postinstall says so and carries on, but this line then
# fails on the missing file.
FROM deps AS h5p-assets
RUN node scripts/fetch-h5p-core.ts --require

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

# Copied explicitly rather than left to `pnpm deploy`, which builds its file
# list the way `pack` does — and these paths are gitignored, so they would be
# silently absent and every H5P asset route would answer 503.
COPY --from=h5p-assets /repo/apps/api/h5p/core ./h5p/core
COPY --from=h5p-assets /repo/apps/api/h5p/editor ./h5p/editor

# Never run as root, and give the H5P working directory to that same user. This
# has to stay after the copies above, or their files keep root's ownership.
RUN useradd --system --create-home --uid 10001 nodeapp \
 && mkdir -p /app/h5p/temporary-storage \
 && chown -R nodeapp:nodeapp /app
USER nodeapp

EXPOSE 8080
CMD ["node", "dist/main.js"]
