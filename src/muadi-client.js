const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

const DEFAULT_SEARCH_TIMEOUT_MS = Number.parseInt(process.env.MUADI_SEARCH_TIMEOUT_MS || '120000', 10);
const DEFAULT_CREATE_BOOKING_TIMEOUT_MS = Number.parseInt(process.env.CREATE_BOOKING_TIMEOUT_MS || '150000', 10);
const RETRY_MAX_ATTEMPTS = Number.parseInt(process.env.MUADI_RETRY_MAX_ATTEMPTS || '3', 10);
const RETRY_BASE_DELAY_MS = Number.parseInt(process.env.MUADI_RETRY_BASE_DELAY_MS || '500', 10);
const RETRY_MAX_DELAY_MS = Number.parseInt(process.env.MUADI_RETRY_MAX_DELAY_MS || '5000', 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoff(attempt, retryAfterHeader) {
  const retryAfterSec = Number.parseFloat(retryAfterHeader || '');
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.min(retryAfterSec * 1000, RETRY_MAX_DELAY_MS * 2);
  }
  const expo = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * RETRY_BASE_DELAY_MS;
  return Math.min(expo + jitter, RETRY_MAX_DELAY_MS);
}

const BASE_URL = 'https://api-gateway.muadi.com.vn/api';
const BOOKING_ORIGIN = 'https://booking.namthanh.vn';

const AES_KEY = process.env.MUADI_AES_KEY || '';
const AES_IV = process.env.MUADI_AES_IV || '';

function assertAesConfigured() {
  if (!AES_KEY || !AES_IV) {
    throw new Error('MUADI_AES_KEY and MUADI_AES_IV env vars must be set to call Muadi API.');
  }
  if (Buffer.byteLength(AES_KEY, 'utf8') !== 16 || Buffer.byteLength(AES_IV, 'utf8') !== 16) {
    throw new Error('MUADI_AES_KEY and MUADI_AES_IV must be exactly 16 bytes (AES-128-CBC).');
  }
}

function encryptMuadi(value) {
  assertAesConfigured();
  const text = String(value);
  const cipher = crypto.createCipheriv(
    'aes-128-cbc',
    Buffer.from(AES_KEY, 'utf8'),
    Buffer.from(AES_IV, 'utf8')
  );
  cipher.setAutoPadding(true);
  return cipher.update(text, 'utf8', 'base64') + cipher.final('base64');
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

/**
 * Decode the `exp` (seconds since epoch) claim from a JWT-shaped access token.
 * Returns 0 when the token is missing / opaque / malformed so callers can treat
 * the expiry as unknown without crashing.
 */
function decodeJwtExpiry(token) {
  try {
    const raw = String(token || '');
    const parts = raw.split('.');
    if (parts.length < 2) return 0;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice((b64.length + 3) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    const exp = Number(payload && payload.exp);
    return Number.isFinite(exp) && exp > 0 ? exp : 0;
  } catch (_) {
    return 0;
  }
}

function tokenStatus(accessToken) {
  const expSec = decodeJwtExpiry(accessToken);
  if (!expSec) return { decodable: false };
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    decodable: true,
    expiresAt: new Date(expSec * 1000).toISOString(),
    expiresInSeconds: expSec - nowSec,
    expired: expSec <= nowSec,
  };
}

function readStorageState(sessionFile = config.paths.sessionFile) {
  if (!fs.existsSync(sessionFile)) {
    throw new Error(`Session file not found: ${sessionFile}. Run npm start or npm run booking -- login first.`);
  }

  const state = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  const origin = (state.origins || []).find((item) => item.origin === BOOKING_ORIGIN);
  if (!origin) {
    throw new Error(`No localStorage state for ${BOOKING_ORIGIN} in ${sessionFile}.`);
  }

  const localStorage = Object.fromEntries(
    (origin.localStorage || []).map((item) => [item.name, item.value])
  );

  if (!localStorage.accessToken) {
    throw new Error(`No accessToken found in ${sessionFile}. Login again before calling Muadi API.`);
  }

  return {
    raw: state,
    localStorage,
    accessToken: localStorage.accessToken,
    refreshToken: localStorage.refreshToken,
    diff: Number.parseInt(localStorage.diff || '0', 10) || 0,
    userInfo: parseJson(localStorage.userInfo, {}),
    agentInfo: parseJson(localStorage.agentInfo, {}),
    additionalFees: parseJson(localStorage.additionalFees, { ADT: 0, CHD: 0, INF: 0 }),
  };
}

function updateSessionTokens(sessionFile, newAccessToken, newRefreshToken) {
  const state = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  const origin = (state.origins || []).find((o) => o.origin === BOOKING_ORIGIN);
  if (!origin) throw new Error(`No origin in session file: ${sessionFile}`);
  for (const item of origin.localStorage || []) {
    if (item.name === 'accessToken') item.value = newAccessToken;
    if (item.name === 'refreshToken' && newRefreshToken) item.value = newRefreshToken;
  }
  fs.writeFileSync(sessionFile, JSON.stringify(state, null, 2));
}

function updateSessionDiff(sessionFile, diffValue) {
  const state = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  const origin = (state.origins || []).find((o) => o.origin === BOOKING_ORIGIN);
  if (!origin) throw new Error(`No origin in session file: ${sessionFile}`);

  const nextDiff = String(diffValue || '0');
  let found = false;
  for (const item of origin.localStorage || []) {
    if (item.name === 'diff') {
      item.value = nextDiff;
      found = true;
      break;
    }
  }

  if (!found) {
    origin.localStorage = origin.localStorage || [];
    origin.localStorage.push({ name: 'diff', value: nextDiff });
  }

  fs.writeFileSync(sessionFile, JSON.stringify(state, null, 2));
}

function isInvalidTokenResponse(status, data) {
  const code = data && String(data.code || '');
  const message = data && String(data.message || data.error || '');
  const looksLikeTokenError = code === '12' || code === '18' || /token/i.test(message);

  if (!looksLikeTokenError) return false;
  if (status === 401) return true;

  // Some Muadi endpoints return HTTP 200 with success=false for expired/invalid
  // booking tokens, for example "Create token failed !!!" on create-session.
  return !!(data && data.success === false);
}

class MuadiApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MuadiApiError';
    this.status = details.status;
    this.data = details.data;
    this.path = details.path;
    this.safeToRetry = details.safeToRetry;
  }
}

class MuadiApiClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || BASE_URL;
    this.sessionFile = options.sessionFile || config.paths.sessionFile;
    this.reloadSession();
  }

  reloadSession() {
    this.session = readStorageState(this.sessionFile);
    this.accessToken = this.session.accessToken;
  }

  _updateTokens(newAccess, newRefresh) {
    this.accessToken = newAccess;
    this.session.accessToken = newAccess;
    if (newRefresh) this.session.refreshToken = newRefresh;
    updateSessionTokens(this.sessionFile, newAccess, newRefresh || this.session.refreshToken);
  }

  async tryRefreshToken() {
    const { refreshToken } = this.session;
    if (!refreshToken) {
      logger.warn('[muadi] tryRefreshToken: no refreshToken in session, skip refresh');
      return false;
    }

    const variants = [
      { name: 'full', body: { accessToken: this.accessToken, refreshToken, channel: 'Web' } },
      { name: 'refreshToken', body: { refreshToken } },
      { name: 'token', body: { token: refreshToken } },
      { name: 'refresh_token', body: { refresh_token: refreshToken } },
    ];

    const attemptLog = [];
    for (const variant of variants) {
      try {
        const res = await axios.post(
          `${this.baseUrl.replace(/\/$/, '')}/auth/refresh-token`,
          { encrypted: encryptMuadi(JSON.stringify(variant.body)) },
          { headers: this.buildHeaders(null), validateStatus: () => true, timeout: 15000 }
        );
        if (res.status === 200 && res.data) {
          const d = res.data.data || res.data;
          const newAccess = d.accessToken;
          if (newAccess) {
            this._updateTokens(newAccess, d.refreshToken);
            logger.info(`[muadi] Token refreshed via variant=${variant.name}`);
            return true;
          }
          attemptLog.push(`${variant.name}: status=${res.status} no accessToken in response (code=${d && d.code}, msg=${d && d.message})`);
        } else {
          attemptLog.push(`${variant.name}: status=${res.status}`);
        }
      } catch (error) {
        attemptLog.push(`${variant.name}: ${error.message}`);
      }
    }
    logger.error('[muadi] tryRefreshToken failed all variants:', attemptLog.join(' | '));
    return false;
  }

  buildHeaders(version = '2') {
    const diff = Number.parseInt(this.session.localStorage.diff || '0', 10) || 0;
    const tsp = Math.floor(Date.now() / 1000) + diff;
    const headers = {
      authorization: this.accessToken,
      tsp: encryptMuadi(tsp.toString()),
      'Client-Type': 'Web',
      'X-Language': this.session.localStorage.i18nextLng || 'vi',
      Origin: BOOKING_ORIGIN,
      Referer: `${BOOKING_ORIGIN}/`,
      'Content-Type': 'application/json',
    };

    if (version) {
      headers['X-Api-Version'] = String(version);
    }

    return headers;
  }

  async post(path, body = {}, options = {}) {
    const version = options.version === undefined ? '2' : options.version;
    const timeout = options.timeout || DEFAULT_SEARCH_TIMEOUT_MS;
    const cleanPath = path.replace(/^\/+/, '').replace(/^api\//, '');
    const url = `${this.baseUrl.replace(/\/$/, '')}/${cleanPath}`;
    const payload = options.encrypt === false ? body : { encrypted: encryptMuadi(JSON.stringify(body || {})) };
    const canRetry = options.safeToRetry !== false;
    const retryAttempts = canRetry ? Math.max(1, RETRY_MAX_ATTEMPTS) : 1;

    let response;
    let lastNetworkError;
    for (let attempt = 0; attempt < retryAttempts; attempt++) {
      try {
        response = await axios.post(url, payload, {
          timeout,
          headers: this.buildHeaders(version),
          validateStatus: () => true,
        });
        lastNetworkError = undefined;
      } catch (error) {
        lastNetworkError = error;
        response = undefined;
        if (attempt < retryAttempts - 1) {
          const delay = computeBackoff(attempt);
          logger.warn(`[muadi] ${cleanPath} network error (attempt ${attempt + 1}/${retryAttempts}): ${error.message}, retry in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw new MuadiApiError(`Muadi API request failed after ${retryAttempts} attempts: ${error.message}`, {
          path: cleanPath,
          safeToRetry: canRetry,
        });
      }

      const status = response.status;
      const retryableStatus = status === 429 || status === 503 || (status >= 500 && status < 600);
      if (retryableStatus && attempt < retryAttempts - 1) {
        const retryAfter = response.headers && (response.headers['retry-after'] || response.headers['Retry-After']);
        const delay = computeBackoff(attempt, retryAfter);
        logger.warn(`[muadi] ${cleanPath} status=${status} (attempt ${attempt + 1}/${retryAttempts}), retry in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      break;
    }

    if (!response) {
      throw lastNetworkError || new MuadiApiError('Muadi API request failed with no response.', {
        path: cleanPath,
        safeToRetry: canRetry,
      });
    }

    const serverTime = response.headers && (response.headers.time || response.headers.Time);
    if (serverTime) {
      const diff = Number.parseInt(serverTime, 10) - Math.floor(Date.now() / 1000);
      if (Number.isFinite(diff)) {
        this.session.localStorage.diff = String(diff);
        try {
          updateSessionDiff(this.sessionFile, this.session.localStorage.diff);
        } catch (error) {
          logger.warn(`[muadi] failed to persist diff to session file: ${error.message}`);
        }
      }
    }

    const data = response.data;
    if (isInvalidTokenResponse(response.status, data)) {
      if (!options._retried) {
        const refreshed = await this.tryRefreshToken();
        if (refreshed) {
          return this.post(path, body, { ...options, _retried: true });
        }
      }
      throw new MuadiApiError(data && data.message ? data.message : 'Invalid Muadi token.', {
        status: response.status,
        data,
        path: cleanPath,
        safeToRetry: options.safeToRetry !== false,
      });
    }

    if (response.status < 200 || response.status >= 300) {
      throw new MuadiApiError(`Muadi API error ${response.status} on ${cleanPath}`, {
        status: response.status,
        data,
        path: cleanPath,
        safeToRetry: options.safeToRetry,
      });
    }

    if (data && data.success === false) {
      throw new MuadiApiError(data.message || `Muadi API returned success=false on ${cleanPath}`, {
        status: response.status,
        data,
        path: cleanPath,
        safeToRetry: options.safeToRetry,
      });
    }

    return data;
  }

  async get(path, options = {}) {
    const version = options.version === undefined ? '2' : options.version;
    const timeout = options.timeout || 15000;
    const cleanPath = path.replace(/^\/+/, '').replace(/^api\//, '');
    const url = `${this.baseUrl.replace(/\/$/, '')}/${cleanPath}`;

    let response;
    try {
      response = await axios.get(url, {
        timeout,
        headers: this.buildHeaders(version),
        validateStatus: () => true,
      });
    } catch (error) {
      throw new MuadiApiError(`Muadi GET ${cleanPath} failed: ${error.message}`, {
        path: cleanPath,
        safeToRetry: true,
      });
    }

    const data = response.data;
    const serverTime = response.headers && (response.headers.time || response.headers.Time);
    if (serverTime) {
      const diff = Number.parseInt(serverTime, 10) - Math.floor(Date.now() / 1000);
      if (Number.isFinite(diff)) {
        this.session.localStorage.diff = String(diff);
        try {
          updateSessionDiff(this.sessionFile, this.session.localStorage.diff);
        } catch (error) {
          logger.warn(`[muadi] failed to persist diff to session file: ${error.message}`);
        }
      }
    }

    if (isInvalidTokenResponse(response.status, data)) {
      if (!options._retried) {
        const refreshed = await this.tryRefreshToken();
        if (refreshed) return this.get(path, { ...options, _retried: true });
      }
      throw new MuadiApiError(data && data.message ? data.message : 'Invalid Muadi token.', {
        status: response.status, data, path: cleanPath, safeToRetry: true,
      });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new MuadiApiError(`Muadi API error ${response.status} on GET ${cleanPath}`, {
        status: response.status, data, path: cleanPath, safeToRetry: true,
      });
    }
    if (data && typeof data === 'object' && data.success === false) {
      throw new MuadiApiError(data.message || `Muadi API returned success=false on GET ${cleanPath}`, {
        status: response.status, data, path: cleanPath, safeToRetry: true,
      });
    }
    return data;
  }

  async getExchangeRate() {
    const data = await this.get('agent/exchange-rate', { version: null });
    const raw = data && (data.data !== undefined ? data.data : data);
    const value = Number.parseFloat(String(raw));
    if (!Number.isFinite(value) || value <= 0) {
      throw new MuadiApiError('Muadi agent/exchange-rate returned invalid rate.', {
        path: 'agent/exchange-rate', data, safeToRetry: true,
      });
    }
    return value;
  }

  async createSession(body) {
    // Muadi trả 403 khi tạo session dồn dập (nhiều search đồng thời / bấm tìm liên tục).
    // post() đã retry 429/503/5xx; bổ sung retry có backoff cho 403. KHÔNG serialize toàn cục
    // để tránh head-of-line blocking (1 create-session chậm làm kẹt mọi search). timeout 20s.
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.post('booking/create-session', body, { version: '2', safeToRetry: true, timeout: 20000 });
      } catch (err) {
        lastErr = err;
        if (err instanceof MuadiApiError && err.status === 403 && attempt < 3) {
          await sleep(computeBackoff(attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  searchFlightByAirline(airline, body) {
    return this.post(`booking/search-flight/${airline}`, body, { version: '2', safeToRetry: true });
  }

  searchLowestFare({ origin, destination, currencyCode = 'VND' }) {
    return this.post('booking/search-lowest-fare', {
      currencyCode,
      originCode: String(origin || '').trim().toUpperCase(),
      destinationCode: String(destination || '').trim().toUpperCase(),
    }, { version: '2', safeToRetry: true });
  }

  createBooking(body) {
    const timeout = Number.isFinite(DEFAULT_CREATE_BOOKING_TIMEOUT_MS) && DEFAULT_CREATE_BOOKING_TIMEOUT_MS > 0
      ? DEFAULT_CREATE_BOOKING_TIMEOUT_MS
      : 150000;
    return this.post('booking/create-booking', body, {
      version: '3',
      timeout,
      safeToRetry: false,
    });
  }

  getAncillaries(body) {
    const payload = body && typeof body === 'object' ? body : {};
    const routePayload = payload.Routes || payload.routes || payload.listRoutes || [];
    return this.post('booking/ancillaries', {
      sessionID: payload.sessionID || payload.SessionID || payload.sessionId || 0,
      Routes: routePayload,
      ADT: Number.parseInt(payload.ADT || payload.adt || '1', 10) || 1,
      CHD: Number.parseInt(payload.CHD || payload.chd || '0', 10) || 0,
      INF: Number.parseInt(payload.INF || payload.inf || '0', 10) || 0,
    }, {
      version: '3',
      safeToRetry: true,
    });
  }

  verifyAgent(body) {
    return this.post('agent/verify', body, {
      version: null,
      safeToRetry: true,
    });
  }

  getTicketInfoBySessionId(sessionID) {
    return this.post('booking/ticket-info-by-id', { sessionID }, { version: '3', safeToRetry: false });
  }
}

module.exports = {
  BASE_URL,
  BOOKING_ORIGIN,
  MuadiApiClient,
  MuadiApiError,
  encryptMuadi,
  isInvalidTokenResponse,
  readStorageState,
  updateSessionTokens,
  updateSessionDiff,
  decodeJwtExpiry,
  tokenStatus,
};
