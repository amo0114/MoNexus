# syntax=docker/dockerfile:1.7

# Stage 1 — build: install full deps, generate Prisma client, transpile TS.
FROM node:20-alpine AS builder
RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Stage 2 — runtime: minimal image carrying built artifacts + the Prisma
# client that was generated against this image's native binary target.
FROM node:20-alpine AS runtime
# pg_dump / pg_restore talk to PostgreSQL over the normal network protocol.
# This keeps portable backups independent from Docker sockets and host volumes.
RUN apk add --no-cache openssl tini wget tar gzip postgresql16-client && \
    addgroup -S app && adduser -S app -G app
WORKDIR /app
# 业务日历判定已在代码层显式使用 Asia/Shanghai（lib/businessTime.ts）；
# TZ 仅兜底日志与未显式指定时区的展示，不承载业务语义。
ENV NODE_ENV=production \
    PORT=3000 \
    TZ=Asia/Shanghai

# Carrying full node_modules (including prisma CLI) keeps the image
# ~80MB larger than --omit=dev but avoids reinstalling at startup just
# to run `prisma migrate deploy`. Acceptable for now; revisit if pulling
# image becomes a bottleneck.
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/prisma ./prisma
COPY --chown=app:app package.json package-lock.json ./

USER app
EXPOSE 3000

# Tini reaps zombies properly (Node.js doesn't by default in PID 1).
ENTRYPOINT ["/sbin/tini", "--"]

# Run migrations then start the server. If migrations fail, the
# container exits and Docker's restart policy + healthcheck will surface
# the issue instead of silently starting against an outdated schema.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
