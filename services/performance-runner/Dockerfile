ARG RUNNER_BASE=mcr.microsoft.com/playwright:v1.56.1-noble
FROM ${RUNNER_BASE}
USER root
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate
ENV PUPPETEER_SKIP_DOWNLOAD=true CHROME_PATH=/ms-playwright/chromium-1194/chrome-linux/chrome
WORKDIR /opt/review/services/performance-runner
COPY services/performance-runner/package.json services/performance-runner/pnpm-lock.yaml ./
RUN pnpm --ignore-workspace install --prod --frozen-lockfile
COPY services/performance-runner/src ./src
COPY plugins/performance-observatory/src/contract.js /opt/review/plugins/performance-observatory/src/contract.js
USER pwuser
ENTRYPOINT ["node", "src/run.mjs"]
