# Multi-stage build for Mini-site.
FROM node:20-alpine AS builder
WORKDIR /work
RUN apk add --no-cache git python3 make g++
RUN npm install -g pnpm@9
COPY package.json pnpm-workspace.yaml ./
COPY packages/core ./packages/core
COPY apps/mini-site ./apps/mini-site
RUN pnpm install --no-frozen-lockfile
WORKDIR /work/apps/mini-site
RUN pnpm exec vite build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache git
COPY --from=builder /work/package.json /work/pnpm-workspace.yaml ./
COPY --from=builder /work/node_modules ./node_modules
COPY --from=builder /work/packages ./packages
COPY --from=builder /work/apps/mini-site/package.json ./apps/mini-site/package.json
COPY --from=builder /work/apps/mini-site/node_modules ./apps/mini-site/node_modules
COPY --from=builder /work/apps/mini-site/dist ./apps/mini-site/dist
COPY apps/mini-site/server.js ./apps/mini-site/server.js
EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0
WORKDIR /app/apps/mini-site
CMD ["node", "server.js"]
