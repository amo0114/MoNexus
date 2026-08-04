# syntax=docker/dockerfile:1.7

# Stage 1 — build: install deps, run TS check + Vite build, output to /app/dist.
FROM node:20-alpine AS builder
WORKDIR /app
ARG VITE_SENTRY_DSN=
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN

COPY package.json package-lock.json ./
COPY scripts/check-runtime.mjs ./scripts/check-runtime.mjs
RUN npm ci

COPY tsconfig.json vite.config.ts tailwind.config.js postcss.config.js index.html ./
COPY src ./src
# Vite copies public/ verbatim into dist/.  The brand marks and favicon are
# referenced by root-relative URLs, so omitting this directory produces a
# successful build with 404s only after deployment.
COPY public ./public
RUN npm run build

# Stage 2 — runtime: nginx serves the built SPA and proxies /api to the
# server container over the compose network.
FROM nginx:1.27-alpine AS runtime
RUN apk add --no-cache wget
# The official nginx entrypoint expands STORAGE_BUCKET / DELIVERY_STORAGE_BUCKET
# in this template at startup. Other $variables remain nginx runtime variables.
ENV STORAGE_BUCKET=monexus-uploads
ENV DELIVERY_STORAGE_BUCKET=monexus-files
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost/ || exit 1
