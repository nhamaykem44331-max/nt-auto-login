# Lean image: chỉ chạy Node API (đăng nhập Muadi qua api-login). KHÔNG Chromium, KHÔNG Python OCR.
#
# Điều kiện deploy: api-login (POST /auth/login) phải hoạt động — xác nhận trên /health rằng
# login.lastVia="api" và login.fallbackCount ngừng tăng (xem commit Phase 1 + observability).
#
# Khẩn cấp bật lại fallback browser+OCR: `git revert` commit này để quay về image
# Playwright + ddddocr (heavy), rồi set lại env DDDDOCR_API_URL/HEADLESS trên Render.
FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production \
    BACKEND_PORT=3100 \
    PORT=3100

COPY package*.json ./
# --omit=optional bỏ playwright (đã chuyển sang optionalDependencies) → image nhẹ, RAM thấp,
# không tải Chromium. Fallback browser sẽ báo lỗi rõ nếu bị gọi (yêu cầu api-login hoạt động).
RUN npm ci --omit=dev --omit=optional

COPY . .

EXPOSE 3100

CMD ["npm", "run", "api"]
