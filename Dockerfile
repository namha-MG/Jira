# Stage 1: Build Frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Build Backend
FROM node:20-alpine AS backend-builder
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm install
COPY backend .
RUN npm run build

# Stage 3: Final Production Image
FROM node:20-alpine
WORKDIR /app

# Copy backend files and install production dependencies
COPY --from=backend-builder /app/backend/package.json /app/backend/package-lock.json ./
RUN npm install --production
COPY --from=backend-builder /app/backend/dist ./dist

# Copy frontend build output into the public directory
COPY --from=frontend-builder /app/dist ./public

# Environment Configuration
ENV PORT=3001
EXPOSE 3001

CMD ["node", "dist/server.js"]
