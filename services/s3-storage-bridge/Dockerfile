FROM node:24.19.0-bookworm-slim

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/s3-storage-bridge/package.json services/s3-storage-bridge/package.json
RUN pnpm install --filter @journey-studios/s3-storage-bridge... --prod --frozen-lockfile

COPY services/s3-storage-bridge/src services/s3-storage-bridge/src
WORKDIR /workspace/services/s3-storage-bridge
ENV NODE_ENV=production
EXPOSE 9000
USER node
CMD ["node", "src/index.js"]
