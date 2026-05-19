# ==========================================
# Stage 1: Build ứng dụng React với Node.js
# ==========================================
FROM node:20.14.0-alpine AS builder

# Thiết lập thư mục làm việc
WORKDIR /app

# Copy các file quản lý dependencies
COPY package.json package-lock.json ./

# Cài đặt dependencies
RUN npm install

# Copy toàn bộ mã nguồn vào container
COPY . .

# Build ứng dụng Vite cho production
RUN npm run build

# ==========================================
# Stage 2: Serve ứng dụng với Nginx
# ==========================================
FROM nginx:alpine

# Xóa cấu hình Nginx mặc định
RUN rm -rf /etc/nginx/conf.d/*

# Copy file cấu hình Nginx tùy chỉnh của chúng ta vào container
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy thư mục build (dist) từ Stage 1 sang thư mục html của Nginx
COPY --from=builder /app/dist /usr/share/nginx/html

# Expose port 80 cho HTTP traffic
EXPOSE 80

# Chạy Nginx ở chế độ foreground
CMD ["nginx", "-g", "daemon off;"]
