# Server image of the parser (web UI + scheduler). Built on the server by
# deploy/deploy.sh; data (DB, documents, cookie, criteria edits) lives in the
# /app/data volume.

FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain only as a fallback if better-sqlite3 has no prebuilt binary.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY config ./config
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME /app/data
EXPOSE 5173
CMD ["node", "dist/index.js", "serve"]
