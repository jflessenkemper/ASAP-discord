# ── Build stage ──────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Production stage ─────────────────────────────────────────────────
FROM node:20-slim
WORKDIR /app

# Security: run as non-root
RUN groupadd -r asap && useradd -r -g asap -m asap

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Assets needed at runtime
COPY assets/ ./assets/

USER asap

EXPOSE 8080
ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "dist/index.js"]
