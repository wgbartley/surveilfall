# SurveilFall — Scryfall-compatible MTG card server.
# Pure-JS dependencies (express, mysql2), so a slim Alpine image is enough.
# Node 22 provides process.loadEnvFile(), used by the app.
FROM node:22-alpine

WORKDIR /app

# Install production dependencies first so this layer is cached unless the
# manifest changes. package-lock.json is committed, so use `npm ci`.
COPY package.json ./
RUN npm install --omit=dev

# Copy the application source. Large/secret paths (data/, downloads/, .env,
# node_modules) are excluded via .dockerignore.
COPY . .

# The admin import downloads bulk data here at runtime; make it writable by the
# unprivileged runtime user.
RUN mkdir -p /app/downloads && chown -R node:node /app/downloads

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# Drop privileges — node:alpine ships a non-root `node` user.
USER node

# Liveness probe (busybox wget ships with the base image).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3000/healthz || exit 1

CMD ["node", "server.js"]
