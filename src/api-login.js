/**
 * api-login.js
 *
 * Đăng nhập booking.namthanh.vn / Muadi qua API trực tiếp — KHÔNG mở trình duyệt,
 * KHÔNG cần OCR/captcha. Nhanh hơn Playwright nhiều (1 HTTP round-trip ~1s).
 *
 * Vì sao bỏ được captcha: trang login dùng `react-simple-captcha` validate hoàn toàn
 * phía client. Endpoint POST /api/auth/login chỉ yêu cầu field `Otp` non-empty (server
 * không verify được giá trị do client tự sinh), nên gửi Otp bất kỳ là qua.
 *
 * Model login: { UserName, Password, AgentCode, Otp }. Body mã hoá AES-128-CBC như mọi
 * request Muadi, KHÔNG set header X-Api-Version (endpoint login dùng handler model-binding
 * mặc định). Response JSON thường: { accessToken, refreshToken, memberInfo, agentInfo,
 * permissions, tourCode, osi, ... }. Ta ghi vào storage-state.json y hệt Playwright tạo ra,
 * để muadi-client dùng tiếp (kể cả auto refresh-token).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const config = require('./config');
const {
  BASE_URL,
  BOOKING_ORIGIN,
  encryptMuadi,
  decodeJwtExpiry,
} = require('./muadi-client');

const LOGIN_URL = `${BASE_URL.replace(/\/$/, '')}/auth/login`;
const LOGIN_TIMEOUT_MS = Number.parseInt(process.env.API_LOGIN_TIMEOUT_MS || '20000', 10);

// Otp = ô captcha client-side; server chỉ cần non-empty. Random để không gửi giá trị cố định.
function randomOtp() {
  if (process.env.LOGIN_OTP) return String(process.env.LOGIN_OTP);
  return crypto.randomBytes(3).toString('hex').slice(0, 4).toUpperCase();
}

function buildLoginHeaders() {
  const tsp = Math.floor(Date.now() / 1000);
  return {
    tsp: encryptMuadi(tsp.toString()),
    'Client-Type': 'Web',
    'X-Language': 'vi',
    Origin: BOOKING_ORIGIN,
    Referer: `${BOOKING_ORIGIN}/`,
    'Content-Type': 'application/json',
    // KHÔNG set X-Api-Version: endpoint login dùng handler model-binding mặc định.
  };
}

function entries(map) {
  return Object.keys(map)
    .filter((name) => map[name] !== undefined && map[name] !== null)
    .map((name) => ({ name, value: String(map[name]) }));
}

function buildStorageState(data, serverDiff) {
  const expSec = decodeJwtExpiry(data.accessToken);
  const localStorage = entries({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    userInfo: JSON.stringify(data.memberInfo || {}),
    agentInfo: JSON.stringify(data.agentInfo || {}),
    permissions: data.permissions, // chuỗi đã mã hoá sẵn từ server
    tourCode: data.tourCode,
    osi: data.osi,
    productKey: data.productKey,
    isLogin: 'true',
    additionalFees: JSON.stringify({ ADT: 0, CHD: 0, INF: 0 }),
    diff: String(serverDiff || 0),
    i18nextLng: 'vi',
    exp: expSec ? String(expSec) : undefined,
  });
  return { cookies: [], origins: [{ origin: BOOKING_ORIGIN, localStorage }] };
}

/**
 * Đăng nhập trực tiếp qua API và lưu session.
 * @param {object} [options]
 * @param {object} [options.account] - { username, password, agencyCode, sessionFile }
 * @param {string} [options.sessionFile]
 * @returns {Promise<{success:true, username:string, sessionFile:string}>}
 */
async function apiLogin(options = {}) {
  const account = options.account || null;
  const creds = account || config.credentials;
  const sessionFile = options.sessionFile
    || (account && account.sessionFile)
    || config.paths.sessionFile;

  const username = creds.username;
  const password = creds.password;
  const agentCode = creds.agencyCode;
  if (!username || !password || !agentCode) {
    throw new Error('apiLogin: thiếu username/password/agencyCode.');
  }

  const body = { UserName: username, Password: password, AgentCode: agentCode, Otp: randomOtp() };
  const res = await axios.post(
    LOGIN_URL,
    { encrypted: encryptMuadi(JSON.stringify(body)) },
    { headers: buildLoginHeaders(), validateStatus: () => true, timeout: LOGIN_TIMEOUT_MS }
  );

  const data = res.data;
  if (res.status !== 200 || !data || typeof data !== 'object' || !data.accessToken) {
    const msg = (data && (data.message || data.title || data.error))
      || (typeof data === 'string' ? 'encrypted/empty error body' : `HTTP ${res.status}`);
    const err = new Error(`apiLogin thất bại (${username}): ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  // Đồng bộ lệch giờ server (giống muadi-client) để tsp hợp lệ ngay từ request đầu.
  const serverTime = res.headers && (res.headers.time || res.headers.Time);
  let diff = 0;
  if (serverTime) {
    const d = Number.parseInt(serverTime, 10) - Math.floor(Date.now() / 1000);
    if (Number.isFinite(d)) diff = d;
  }

  const state = buildStorageState(data, diff);
  const dir = path.dirname(sessionFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify(state, null, 2));

  return { success: true, username, sessionFile };
}

module.exports = { apiLogin };
