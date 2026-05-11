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
RUN apk add --no-cache openssl tini wget && \
    addgroup -S app && adduser -S app -G app
WORKDIR /app
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
