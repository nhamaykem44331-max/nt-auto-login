// playwright được nạp lazy trong getBrowser() (chỉ khi cần fallback browser+OCR).
// Lean image (Phase 2) bỏ playwright khỏi dependencies → module vẫn load bình thường.
const config = require('./config');
const { login } = require('./login');
const { apiLogin } = require('./api-login');
const logger = require('./logger');

// Mặc định dùng login API trực tiếp (không browser/OCR). Đặt API_LOGIN_DISABLED=true để ép browser.
const API_LOGIN_DISABLED = String(process.env.API_LOGIN_DISABLED || 'false').toLowerCase() === 'true';

// Theo dõi trạng thái đăng nhập để quan sát qua /health: xác nhận api-login đã chạy lại
// (lastVia='api') trước khi gỡ fallback OCR/Chromium ở giai đoạn lean image.
const loginStatus = {
  lastVia: null,       // 'api' | 'browser'
  lastOkAt: null,      // ISO time của lần login thành công gần nhất
  lastApiError: null,  // lý do api-login fail lần gần nhất (null nếu đang OK)
  apiOkCount: 0,
  fallbackCount: 0,
};

function getLoginStatus() {
  return { ...loginStatus };
}

function validateEnv() {
  const required = ['NAMTHANH_USERNAME', 'NAMTHANH_PASSWORD', 'NAMTHANH_AGENCY_CODE'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}

// Tái sử dụng 1 Chromium process giữa các lần login để tiết kiệm 1–2s/launch.
// Đóng context (không đóng browser) sau mỗi lần để giải phóng RAM, nhưng process
// Chromium vẫn sống tới khi backend tắt hoặc headless-mode đổi.
const singleton = { browser: null, headless: null };

async function getBrowser(headless) {
  if (singleton.browser) {
    if (singleton.headless === headless && singleton.browser.isConnected()) {
      return singleton.browser;
    }
    try { await singleton.browser.close(); } catch (_) { /* ignore */ }
    singleton.browser = null;
    singleton.headless = null;
  }

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    throw new Error(
      'Fallback browser+OCR không khả dụng: playwright chưa được cài (lean image). ' +
      'api-login phải hoạt động. Để bật lại fallback: revert commit lean Dockerfile (quay về image Playwright + ddddocr).'
    );
  }

  singleton.browser = await chromium.launch({
    headless,
    slowMo: headless ? 0 : config.browser.slowMo,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  singleton.headless = headless;

  singleton.browser.once('disconnected', () => {
    if (singleton.browser && !singleton.browser.isConnected()) {
      singleton.browser = null;
      singleton.headless = null;
    }
  });

  return singleton.browser;
}

async function closeSingletonBrowser() {
  if (singleton.browser) {
    try { await singleton.browser.close(); } catch (_) { /* ignore */ }
    singleton.browser = null;
    singleton.headless = null;
  }
}

async function runLogin(options = {}) {
  validateEnv();

  // ─── Đường nhanh: login API trực tiếp (1 HTTP round-trip, không browser, không OCR/captcha) ───
  if (!API_LOGIN_DISABLED) {
    try {
      const r = await apiLogin();
      loginStatus.lastVia = 'api';
      loginStatus.lastOkAt = new Date().toISOString();
      loginStatus.lastApiError = null;
      loginStatus.apiOkCount += 1;
      logger.success(`[session-login] API login OK (${r.username}) — bỏ qua browser/OCR.`);
      return { success: true, via: 'api' };
    } catch (err) {
      loginStatus.lastApiError = err.message;
      loginStatus.fallbackCount += 1;
      logger.warn(`[session-login] API login lỗi, fallback browser+OCR: ${err.message}`);
    }
  }

  // ─── Fallback: Playwright + OCR (giữ nguyên cơ chế cũ phòng khi API login đổi) ───
  const headless = options.headless !== undefined ? options.headless : true;
  const browser = await getBrowser(headless);
  let context;
  try {
    const result = await login(browser);
    context = result && result.context;
    if (!result || !result.success) {
      throw new Error('Login did not complete successfully.');
    }
    loginStatus.lastVia = 'browser';
    loginStatus.lastOkAt = new Date().toISOString();
    return { success: true, via: 'browser' };
  } finally {
    if (context && !options.keepOpen) {
      try { await context.close(); } catch (err) {
        logger.warn('[session-login] Không đóng được context:', err.message);
      }
    }
  }
}

module.exports = {
  runLogin,
  validateEnv,
  closeSingletonBrowser,
  getLoginStatus,
};
