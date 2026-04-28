# Nam Thanh Auto-Login Script

## Direct Muadi API workflow

The current production workflow avoids UI scraping for fare and booking steps:

1. Login with Playwright/OCR and save `session/storage-state.json`.
2. Read `accessToken` from localStorage in the saved session.
3. Call Muadi API directly with encrypted body and encrypted `tsp` header.
4. Create a search session.
5. Search flights by airline.
6. Pick the target flight and the cheapest fare.
7. Create booking/hold PNR.
8. Poll ticket info by session ID and print the PNR result.

Start the OCR server before login:

```bash
npm run ocr
```

Login or refresh the session:

```bash
npm run login
```

Check route availability:

```bash
npm run journey -- --from HAN --to SGN --date 21-04-2026 --airline VN
```

Check full fare with tax and fees:

```bash
npm run price -- --from HAN --to SGN --date 21-04-2026 --airline VN --time 05:00
```

Dry-run a hold booking without creating a real PNR:

```bash
npm run hold -- --from HAN --to SGN --date 21-04-2026 --airline VN --time 05:00 --passenger "MR Vu Duc Anh" --dry-run
```

Create a real hold booking:

```bash
npm run hold -- --from HAN --to SGN --date 21-04-2026 --airline VN --time 05:00 --passenger "MR Vu Duc Anh"
```

If the API returns an expired token before booking, the CLI will login again once and retry. After `create-booking` starts, the CLI does not auto-retry because that could create duplicate PNRs.

Script local Node.js tự động đăng nhập vào `booking.namthanh.vn` bằng Playwright + ddddocr để đọc captcha.

## Yêu cầu

- Node.js 18+
- Python 3.8+ (để chạy ddddocr) HOẶC Docker
- Kết nối internet

## Cài đặt

### Bước 1: Cài dependencies

```bash
cd namthanh-auto-login
npm install
npx playwright install chromium
```

### Bước 2: Cài và chạy ddddocr API

**Cách A — Dùng Docker (khuyến nghị):**

```bash
git clone https://github.com/sml2h3/ddddocr.git /tmp/ddddocr
cd /tmp/ddddocr
docker build -t ddddocr-api .
docker run -d --name ddddocr-api -p 8000:8000 \
  -e DDDDOCR_SHOW_AD=false \
  -e DDDDOCR_BETA=true \
  ddddocr-api
```

**Cách B — Chạy Python trực tiếp:**

```bash
pip install "ddddocr[api]"
python -m ddddocr api --port 8000 --beta true --show-ad false
```

Kiểm tra ddddocr chạy OK:

```bash
curl http://localhost:8000/health
# Output mong đợi: {"status":"ok","timestamp":...}
```

### Bước 3: Cấu hình credentials

```bash
cp .env.example .env
# Mở .env, điền NAMTHANH_PASSWORD
```

**⚠️ QUAN TRỌNG: Không commit file `.env` lên GitHub!**

## Sử dụng

### Lần đầu: Inspect trang login

```bash
npm run inspect
```

Script này sẽ:
- Mở trình duyệt Chromium
- Lưu HTML, screenshots, danh sách form elements vào `./debug/`
- Giữ browser mở để Andy inspect thủ công với DevTools
- Note lại các selector chính xác

Sau khi inspect, nếu cần, **cập nhật selectors trong `src/config.js`** cho chính xác hơn.

### Chạy auto-login

```bash
npm start
```

Output mẫu:

```
╔════════════════════════════════════════════════╗
║  Nam Thanh Auto-Login Script                   ║
║  Sử dụng: Playwright + ddddocr                 ║
╚════════════════════════════════════════════════╝

🏥 Kiểm tra ddddocr API...
  ✓ ddddocr API đang hoạt động

📍 Mở https://booking.namthanh.vn/login

🔄 Lần thử 1:
  ✓ Tìm thấy username input với selector: input[name="username"]
  ✓ Đã điền username: HTXTP01
  ✓ Đã điền password: ************
  ✓ Đã điền mã đại lý: AML
  📸 Chụp ảnh captcha...
  💾 Lưu captcha: ./screenshots/captcha-attempt-1.png
  🤖 Gọi ddddocr để đọc captcha...
  🔤 Kết quả OCR: "AB3X7Q"
  ✓ Đã điền captcha: AB3X7Q
  🚀 Đã click submit, chờ kết quả...
  ✅ Đăng nhập thành công!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎉 ĐĂNG NHẬP THÀNH CÔNG!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Cấu trúc project

```
namthanh-auto-login/
├── .env.example           # Template credentials
├── .env                   # Credentials thật (KHÔNG commit)
├── .gitignore
├── package.json
├── README.md
├── src/
│   ├── index.js                 # Entry point
│   ├── config.js                # Selectors + config
│   ├── login.js                 # Logic login + retry
│   ├── ddddocr-client.js        # Client gọi ddddocr API
│   ├── inspect-login-page.js    # Tool khám phá trang login
│   └── test-ocr.js              # Test ddddocr riêng
├── debug/                 # Output của inspect
├── screenshots/           # Screenshots mỗi lần chạy
└── session/
    └── storage-state.json  # Cookie đã save (tái sử dụng)
```

## Troubleshooting

### "ddddocr API không phản hồi"

Kiểm tra ddddocr:
```bash
curl http://localhost:8000/health
docker ps | grep ddddocr   # nếu dùng Docker
```

### "Không tìm thấy username input"

1. Chạy `npm run inspect` để xem HTML thực tế
2. Mở `debug/03-form-inputs.json` xem danh sách inputs
3. Cập nhật selector trong `src/config.js`

### OCR đọc captcha sai > 50%

- Thử `charsetRange` khác trong `.env`:
  - `0` = chỉ số
  - `5` = chữ HOA + số
  - `6` = tất cả
- Kiểm tra ảnh captcha trong `screenshots/captcha-attempt-*.png`
- Nếu captcha có nhiều nhiễu, cân nhắc chuyển sang CapSolver

### "Đã thử 5 lần mà captcha vẫn sai"

- Tăng `MAX_CAPTCHA_RETRY` trong `.env`
- Check `screenshots/` xem captcha trông thế nào
- Có thể trang đã thay đổi captcha sang dạng slide/click → cần update code

## Bước tiếp theo

Sau khi login thành công ổn định, có thể mở rộng:

1. **Module tra giá vé** — dùng session đã lưu để gọi API tra giá vé
2. **Schedule chạy định kỳ** — dùng cron hoặc n8n trigger
3. **Tích hợp vào APG Manager RMS** — convert thành NestJS service
4. **Refresh session tự động** — khi cookie hết hạn, login lại

## Lưu ý an toàn

- ⚠️ Đọc ToS của booking.namthanh.vn trước khi deploy production
- ⚠️ Đổi password ngay nếu đã từng gửi qua chat/email
- ⚠️ Không commit `.env`, `session/`, `screenshots/` lên GitHub
- ⚠️ Dùng VPN/proxy riêng nếu chạy từ IP server (tránh bị flag)
- ⚠️ Thêm rate limit (không chạy liên tục quá nhanh)
