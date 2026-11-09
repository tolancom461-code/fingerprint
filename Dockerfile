# Infrastructure-only staging image. Do not change CMD to the production entry point.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY --chown=node:node src/ ./src/
COPY --chown=node:node scripts/ ./scripts/
RUN mkdir -p /app/var && chown node:node /app/var

USER node
EXPOSE 8080
CMD ["node", "src/railway-staging.js"]
