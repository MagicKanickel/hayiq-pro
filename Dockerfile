# Heubedampfer-Relay – schlankes Node-Image fuer Coolify
FROM node:22-alpine

WORKDIR /app

# Nur Manifeste zuerst -> besseres Layer-Caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Rest der App
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Healthcheck (Coolify/Docker kann ihn nutzen)
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
