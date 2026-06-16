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
// X-Api-Version cho endpoint login. Các call Muadi khác (search/refresh) đều gửi '2'
// (xem muadi-client.buildHeaders). Cho phép override qua env nếu gateway đổi phiên bản.
const LOGIN_API_VERSION = process.env.API_LOGIN_API_VERSION || '2';
// Endpoint login nay yêu cầu field `Channel` (giống refresh-token gửi channel='Web').
// Thiếu field này → server trả "The Channel field is required." (validation error).
const LOGIN_CHANNEL = process.env.API_LOGIN_CHANNEL || 'Web';

// Otp = ô captcha client-side; server chỉ cần non-empty. Random để không gửi giá trị cố định.
function randomOtp() {
  if (process.env.LOGIN_OTP) return String(process.env.LOGIN_OTP);
  return crypto.randomBytes(3).toString('hex').slice(0, 4).toUpperCase();
}

function buildLoginHeaders({ withVersion = false } = {}) {
  const tsp = Math.floor(Date.now() / 1000);
  const headers = {
    tsp: encryptMuadi(tsp.toString()),
    'Client-Type': 'Web',
    'X-Language': 'vi',
    Origin: BOOKING_ORIGIN,
    Referer: `${BOOKING_ORIGIN}/`,
    'Content-Type': 'application/json',
  };
  // Endpoint login KHÔNG dùng X-Api-Version (model-binding mặc định) — đây là path đúng.
  // Chỉ gửi khi self-heal thử lại, phòng trường hợp gateway đổi sang yêu cầu version.
  if (withVersion) headers['X-Api-Version'] = String(LOGIN_API_VERSION);
  return headers;
}

// ASP.NET ValidationProblemDetails: { title, errors: { Field: [msg, ...] } }.
// Gộp errors thành chuỗi để log rõ field nào server từ chối (trước đây bị bỏ đi).
function describeLoginError(data, status) {
  if (!data || typeof data !== 'object') {
    return typeof data === 'string' && data ? 'encrypted/empty error body' : `HTTP ${status}`;
  }
  const parts = [];
  if (data.errors && typeof data.errors === 'object') {
    for (const [field, msgs] of Object.entries(data.errors)) {
      parts.push(`${field}: ${Array.isArray(msgs) ? msgs.join('; ') : String(msgs)}`);
    }
  }
  const base = data.message || data.title || data.error || `HTTP ${status}`;
  return parts.length ? `${base} [${parts.join(' | ')}]` : base;
}

function isLoginSuccess(res) {
  return res.status === 200 && res.data && typeof res.data === 'object' && !!res.data.accessToken;
}

async function postLogin(body, headerOpts) {
  return axios.post(
    LOGIN_URL,
    { encrypted: encryptMuadi(JSON.stringify(body)) },
    { headers: buildLoginHeaders(headerOpts), validateStatus: () => true, timeout: LOGIN_TIMEOUT_MS }
  );
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

  const body = {
    UserName: username,
    Password: password,
    AgentCode: agentCode,
    Channel: LOGIN_CHANNEL,
    Otp: randomOtp(),
  };

  // Path chuẩn: KHÔNG X-Api-Version (model-binding mặc định). Nếu vẫn lỗi, thử lại KÈM
  // X-Api-Version để self-heal khi gateway đổi contract. Login thưa nên 2 request là chấp nhận được.
  let res = await postLogin(body, { withVersion: false });
  if (!isLoginSuccess(res)) {
    const primaryStatus = res.status;
    const primaryDetail = describeLoginError(res.data, res.status);
    const retry = await postLogin(body, { withVersion: true });
    if (isLoginSuccess(retry)) {
      res = retry;
    } else {
      const retryDetail = describeLoginError(retry.data, retry.status);
      const err = new Error(
        `apiLogin thất bại (${username}): [no-version] ${primaryDetail} | [X-Api-Version=${LOGIN_API_VERSION}] ${retryDetail}`
      );
      err.status = primaryStatus;
      err.data = res.data;
      throw err;
    }
  }

  const data = res.data;

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
