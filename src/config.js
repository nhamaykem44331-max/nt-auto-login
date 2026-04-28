/**
 * config.js
 *
 * Selectors đã được xác nhận bằng inspect trên booking.namthanh.vn/login
 */

require('dotenv').config();

module.exports = {
  loginUrl: 'https://booking.namthanh.vn/login',

  credentials: {
    username: process.env.NAMTHANH_USERNAME,
    password: process.env.NAMTHANH_PASSWORD,
    agencyCode: process.env.NAMTHANH_AGENCY_CODE,
  },

  // Selectors CHÍNH XÁC cho namthanh.vn
  selectors: {
    usernameInput: '#username',
    passwordInput: '#password',
    agencyCodeInput: '#agentCode',

    // Captcha là Canvas element
    captchaCanvas: '#canv',
    captchaInput: '#captcha',
    captchaReload: '#reload_href',  // Click để reload captcha

    // Submit button - tìm theo text "Đăng nhập"
    submitButton: 'button:has-text("Đăng nhập"):not(:has-text("QR"))',

    successIndicator: {
      // Sau khi login thành công, URL sẽ đổi khác /login
      urlPattern: /booking\.namthanh\.vn\/(?!login)/,
    },
  },

  captcha: {
    // Captcha namthanh.vn: 3 ký tự, có cả chữ hoa + chữ thường + số
    // Ví dụ thấy: "Y 3 N", "W0 1" → range 6 (lower+upper+digits)
    charsetRange: 6,

    // Độ dài chính xác là 3 (maxlength="3" trên input)
    expectedLength: { min: 3, max: 3 },

    // Retry nhiều hơn vì captcha canvas có thể khó OCR
    maxRetry: 10,

    useBeta: true,
  },

  ddddocr: {
    apiUrl: process.env.DDDDOCR_API_URL || 'http://localhost:8001',
    timeout: 10000,
  },

  browser: {
    headless: process.env.HEADLESS === 'true',
    slowMo: parseInt(process.env.HEADLESS === 'true' ? '0' : '100', 10),
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
  },

  paths: {
    screenshotDir: process.env.SCREENSHOT_DIR || './screenshots',
    sessionFile: process.env.SESSION_FILE || './session/storage-state.json',
  },
};
