# ─── WattLab API — production image ───
FROM node:20-alpine AS base
WORKDIR /app

# Solo i manifest prima (layer caching: reinstalla solo se cambiano le deps)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# tsx serve a runtime per eseguire TypeScript direttamente
RUN npm install tsx drizzle-kit typescript @types/node

# Codice + migrazioni versionate
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle

# Sicurezza: utente non-root
RUN addgroup -S wattlab && adduser -S wattlab -G wattlab \
  && chown -R wattlab:wattlab /app
USER wattlab

ENV NODE_ENV=production
# Container read-only: tutte le cache puntano a /tmp (tmpfs scrivibile)
ENV npm_config_cache=/tmp/.npm
ENV HOME=/tmp
EXPOSE 3000

# Healthcheck per Docker/Compose
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

# Le migrazioni versionate vengono applicate al boot da src/index.ts
# (con retry sul DB), poi parte l'API. Niente più drizzle-kit push.
CMD ["npx", "tsx", "src/index.ts"]
