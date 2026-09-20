# ══════════════════════════════════════════════════════════════════════════════
# CloudDrive Production Multi-Cloud Storage Dockerfile
# ══════════════════════════════════════════════════════════════════════════════

FROM node:20-alpine

WORKDIR /app

# Install system utilities & native build tools
RUN apk add --no-cache python3 make g++ libc6-compat curl tzdata

# Copy package definitions
COPY package*.json ./

# Install npm dependencies
RUN npm install --omit=dev

# Copy full application codebase
COPY . .

# Create necessary persistent storage and cache directories
RUN mkdir -p /app/data /app/data/cache /app/data/tmp /app/data/thumbnails
RUN chown -R node:node /app

# Environment settings
ENV NODE_ENV=production
ENV PORT=3000

# Expose Web & WebDAV port
EXPOSE 3000

USER node

# Health check probe
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/setup/status || exit 1

# Start server
CMD ["node", "server.js"]
