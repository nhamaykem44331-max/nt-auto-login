FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HEADLESS=true \
    LOGIN_SKIP_SCREENSHOTS=true \
    DDDDOCR_API_URL=http://127.0.0.1:8001 \
    BACKEND_PORT=3100 \
    PORT=3100

COPY package*.json ./
RUN npm ci --omit=dev

RUN pip3 install --no-cache-dir flask ddddocr

COPY . .

EXPOSE 3100

CMD ["sh", "-c", "python3 ocr_server.py 8001 & npm run api"]
