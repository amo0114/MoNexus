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
# 不设 TZ：业务日历已在代码层显式使用 Asia/Shanghai（lib/businessTime.ts），
# 与运行时区无关；镜像层改 TZ 会波及所有本地日期运算（每日风控、Dashboard），
# 且 CI 仍是 UTC——如需全局时区改造应独立立项而非顺手改。
ENV NODE_ENV=production \
    PORT=3000

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
