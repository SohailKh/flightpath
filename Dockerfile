# Flightpath Docker Image
# Multi-stage build for Node.js + Bun environment with Claude Code CLI

# Stage 1: Base image with Node.js and Bun
FROM node:20-slim AS base

# Install Bun
RUN npm install -g bun

# Install git (needed for project initialization)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Stage 2: Install backend dependencies
FROM base AS backend-deps
WORKDIR /app/backend
COPY backend/package.json backend/bun.lockb ./
RUN bun install --frozen-lockfile

# Stage 3: Install UI dependencies and build
FROM base AS ui-deps
WORKDIR /app/ui
COPY ui/package.json ui/bun.lockb ./
RUN bun install --frozen-lockfile

# Stage 4: Build UI
FROM ui-deps AS ui-build
COPY ui/ ./
RUN bun run build

# Stage 5: Final runtime image
FROM base AS final
WORKDIR /app

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Install tsx for running TypeScript with Node.js (required for Agent SDK)
RUN npm install -g tsx

# Copy root package files (for shared dependencies like playwright)
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

# Copy backend with dependencies
COPY --from=backend-deps /app/backend/node_modules ./backend/node_modules
COPY backend/ ./backend/

# Copy built UI
COPY --from=ui-build /app/ui/dist ./ui/dist
# Also copy UI node_modules for dev server
COPY --from=ui-deps /app/ui/node_modules ./ui/node_modules
COPY ui/package.json ui/vite.config.ts ui/tsconfig*.json ./ui/
COPY ui/src ./ui/src
COPY ui/index.html ./ui/

# Install Playwright browsers (chromium only to reduce image size)
RUN npx playwright install chromium --with-deps

# Create directories for persistence
RUN mkdir -p /app/backend/.flightpath /app/backend/.claude /app/projects

# Default ports
EXPOSE 8787 5173

# Default command (can be overridden in docker-compose)
CMD ["npx", "tsx", "backend/src/index.ts"]
