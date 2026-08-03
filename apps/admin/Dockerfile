# The admin panel is a static SPA. It is served by nginx rather than Node
# because there is nothing to render server-side — it is behind a login and
# invisible to crawlers.
#
# Build context is the repo root:  docker build -f apps/admin/Dockerfile .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/admin/package.json apps/admin/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @speakukrainian/admin... --filter @speakukrainian/shared...

FROM deps AS build
COPY tsconfig.base.json turbo.json ./
COPY packages/shared packages/shared
COPY apps/admin apps/admin
RUN pnpm --filter @speakukrainian/shared build \
 && pnpm --filter @speakukrainian/admin build

FROM nginx:1.29-alpine AS runtime
COPY apps/admin/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/admin/dist/admin/browser /usr/share/nginx/html

# The base image's entrypoint expands ${PORT} in the template, which is how the
# container honours the port Cloud Run assigns.
ENV PORT=8080
EXPOSE 8080
