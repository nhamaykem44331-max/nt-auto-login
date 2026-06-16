#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');
const config = require('./config');
const { runLogin, closeSingletonBrowser, getLoginStatus } = require('./session-login');
const { getAirportsList } = require('./airports');
const {
  MuadiApiClient,
  MuadiApiError,
  readStorageState,
  decodeJwtExpiry,
  tokenStatus,
} = require('./muadi-client');
const { handleLowestFareRequest } = require('./routes/lowest-fare');
const ocrClient = require('./ddddocr-client');
const {
  buildAncillariesRequest,
  buildBookRequest,
  buildSearchRequest,
  cheapestFare,
  createBookingWithProtection,
  flightsFromSearchResponse,
  flightsFromSearchResponseRT,
  hasAnyPnrResponse,
  hasCompletePnrResponse,
  holdFlight,
  isBookingProtectionError,
  parsePassengerName,
  priceFlight,
  refreshBookRequestLuggage,
  searchJourney,
  summarizeFlightFare,
  summarizeHoldResult,
  verifyBookingProtection,
} = require('./booking-workflow');
const logger = require('./logger');

const DEFAULT_PORT = Number.parseInt(process.env.BACKEND_PORT || process.env.PORT || '3100', 10);
const CACHE_TTL_MS = Number.parseInt(process.env.SEARCH_CACHE_TTL_SECONDS || '900', 10) * 1000;
const BOOKING_CACHE_TTL_MS = Number.parseInt(process.env.BOOKING_CACHE_TTL_SECONDS || '3600', 10) * 1000;
const ANCILLARY_CACHE_TTL_MS = Number.parseInt(process.env.ANCILLARY_CACHE_TTL_SECONDS || '120', 10) * 1000;
const API_KEY = process.env.BACKEND_API_KEY || process.env.API_SECRET_KEY || '';
const ALLOW_NO_AUTH = String(process.env.BACKEND_ALLOW_NO_AUTH || '').toLowerCase() === 'true';
const CORS_ORIGIN_RAW = process.env.BACKEND_CORS_ORIGIN || '*';
const CORS_ALLOW_ALL = CORS_ORIGIN_RAW.trim() === '*';
const CORS_ALLOWED_ORIGINS = CORS_ALLOW_ALL
  ? null
  : new Set(
      CORS_ORIGIN_RAW.split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    );

function resolveCorsOrigin(req) {
  const origin = req && req.headers && req.headers.origin;
  if (CORS_ALLOW_ALL) return '*';
  if (!origin) return '';
  return CORS_ALLOWED_ORIGINS.has(origin) ? origin : '';
}

if (!API_KEY && !ALLOW_NO_AUTH) {
  console.error('[FATAL] BACKEND_API_KEY is empty. Set BACKEND_API_KEY, or explicitly set BACKEND_ALLOW_NO_AUTH=true for local dev only.');
  process.exit(1);
}

const searchCache = new Map();
const bookingCache = new Map();
const idempotencyCache = new Map();
const ancillaryCache = new Map();
const inflightAncillaries = new Map();
const inflightSearch = new Map();
const searchResponseCache = new Map();
const SEARCH_RESPONSE_CACHE_TTL_SECONDS = Number.parseInt(process.env.SEARCH_RESPONSE_CACHE_TTL_SECONDS || '90', 10);
const SEARCH_RESPONSE_CACHE_TTL_MS = (
  Number.isFinite(SEARCH_RESPONSE_CACHE_TTL_SECONDS) && SEARCH_RESPONSE_CACHE_TTL_SECONDS > 0
    ? SEARCH_RESPONSE_CACHE_TTL_SECONDS
    : 90
) * 1000;

const EXCHANGE_RATE_TTL_MS = Number.parseInt(process.env.EXCHANGE_RATE_TTL_SECONDS || '300', 10) * 1000;
const EXCHANGE_RATE_FALLBACK = Number.parseFloat(process.env.EXCHANGE_RATE_FALLBACK || '26357') || 26357;
let exchangeRateCache = { value: null, fetchedAt: 0 };
let exchangeRateInflight = null;
const AIRPORTS_JSON_PATH = path.join(__dirname, '../data/airports.json');

function computePriceUSD(vnd) {
  const rate = (exchangeRateCache && exchangeRateCache.value) || EXCHANGE_RATE_FALLBACK;
  return Math.round(Number(vnd || 0) / rate);
}

// ─── Session manager: proactive refresh + warm-up + login mutex ──────────────
const TOKEN_REFRESH_LEAD_MS = Number.parseInt(process.env.TOKEN_REFRESH_LEAD_MS || '120000', 10); // 2 min before exp
const TOKEN_REFRESH_MIN_DELAY_MS = Number.parseInt(process.env.TOKEN_REFRESH_MIN_DELAY_MS || '5000', 10);
const TOKEN_REFRESH_MAX_DELAY_MS = Number.parseInt(process.env.TOKEN_REFRESH_MAX_DELAY_MS || '3600000', 10); // 1 hr ceiling
const WARMUP_ENABLED = String(process.env.BACKEND_WARMUP || 'true').toLowerCase() !== 'false';
const HOLD_PRICING_TICKETINFO_ATTEMPTS = Number.parseInt(process.env.HOLD_PRICING_TICKETINFO_ATTEMPTS || '3', 10);
const HOLD_PRICING_TICKETINFO_INITIAL_DELAY_MS = Number.parseInt(process.env.HOLD_PRICING_TICKETINFO_INITIAL_DELAY_MS || '250', 10);
const HOLD_PRICING_FALLBACK_ATTEMPTS = Number.parseInt(
  process.env.HOLD_PRICING_FALLBACK_ATTEMPTS || process.env.HOLD_PRICING_SYNC_ATTEMPTS || '2',
  10
);
const HOLD_PRICING_FALLBACK_INITIAL_DELAY_MS = Number.parseInt(
  process.env.HOLD_PRICING_FALLBACK_INITIAL_DELAY_MS || process.env.HOLD_PRICING_SYNC_INITIAL_DELAY_MS || '300',
  10
);

let loginInflight = null;
let refreshTimer = null;
let lastRefreshAt = 0;
let lastRefreshOk = null;

async function runLoginCoalesced(options = {}) {
  if (loginInflight) return loginInflight;
  loginInflight = (async () => {
    try {
      const result = await runLogin(options);
      return result;
    } finally {
      loginInflight = null;
      // Schedule based on fresh session
      setImmediate(() => scheduleProactiveRefresh());
    }
  })();
  return loginInflight;
}

function sessionExpMs() {
  try {
    const state = readStorageState(config.paths.sessionFile);
    const expSec = decodeJwtExpiry(state.accessToken);
    return expSec ? expSec * 1000 : 0;
  } catch (_) {
    return 0;
  }
}

function scheduleProactiveRefresh() {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  const expMs = sessionExpMs();
  if (!expMs) {
    // Unknown expiry (opaque token or no session) — skip scheduling.
    return;
  }
  const now = Date.now();
  let delay = expMs - now - TOKEN_REFRESH_LEAD_MS;
  if (delay < TOKEN_REFRESH_MIN_DELAY_MS) delay = TOKEN_REFRESH_MIN_DELAY_MS;
  if (delay > TOKEN_REFRESH_MAX_DELAY_MS) delay = TOKEN_REFRESH_MAX_DELAY_MS;

  refreshTimer = setTimeout(() => { refreshTokenJob().catch(() => {}); }, delay);
  if (refreshTimer.unref) refreshTimer.unref();
  console.log(`[session] Next proactive refresh in ${Math.round(delay / 1000)}s (token exp ${new Date(expMs).toISOString()})`);
}

async function refreshTokenJob() {
  try {
    const client = new MuadiApiClient();
    const ok = await client.tryRefreshToken();
    lastRefreshAt = Date.now();
    lastRefreshOk = ok;
    if (ok) {
      console.log('[session] Proactive refresh OK');
    } else {
      console.warn('[session] Proactive refresh failed, running full login...');
      await runLoginCoalesced({ headless: true });
    }
  } catch (err) {
    lastRefreshAt = Date.now();
    lastRefreshOk = false;
    console.error('[session] Proactive refresh error:', err && err.message);
    try { await runLoginCoalesced({ headless: true }); } catch (_) { /* logged upstream */ }
  } finally {
    scheduleProactiveRefresh();
  }
}

async function warmUpSession() {
  if (!WARMUP_ENABLED) {
    console.log('[warmup] Disabled via BACKEND_WARMUP=false');
    return;
  }
  const started = Date.now();
  try {
    if (!fs.existsSync(config.paths.sessionFile)) {
      console.log('[warmup] No session file — running initial login...');
      await runLoginCoalesced({ headless: true });
      console.log(`[warmup] Initial login done in ${Date.now() - started}ms`);
      return;
    }

    const state = readStorageState(config.paths.sessionFile);
    const status = tokenStatus(state.accessToken);
    if (status.decodable && !status.expired && status.expiresInSeconds > TOKEN_REFRESH_LEAD_MS / 1000) {
      console.log(`[warmup] Session OK (expires in ${status.expiresInSeconds}s at ${status.expiresAt})`);
      scheduleProactiveRefresh();
      return;
    }

    // Expired / near expiry / opaque token — try refresh first, fall back to full login.
    console.log('[warmup] Token needs refresh — trying refresh-token...');
    const client = new MuadiApiClient();
    const ok = await client.tryRefreshToken();
    if (ok) {
      lastRefreshAt = Date.now();
      lastRefreshOk = true;
      console.log(`[warmup] Refresh OK in ${Date.now() - started}ms`);
    } else {
      console.log('[warmup] Refresh failed — running full login...');
      await runLoginCoalesced({ headless: true });
      console.log(`[warmup] Full login done in ${Date.now() - started}ms`);
    }
    scheduleProactiveRefresh();
  } catch (err) {
    console.error('[warmup] Failed:', err && err.message);
    // Don't crash the server — first real request will still trigger on-demand login.
  }
}

function sessionManagerStatus() {
  let token = { decodable: false };
  let sessionFile = false;
  try {
    if (fs.existsSync(config.paths.sessionFile)) {
      sessionFile = true;
      const state = readStorageState(config.paths.sessionFile);
      token = tokenStatus(state.accessToken);
    }
  } catch (_) { /* ignore */ }
  return {
    sessionFile,
    token,
    loginInProgress: !!loginInflight,
    lastRefreshAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null,
    lastRefreshOk,
    refreshScheduled: !!refreshTimer,
  };
}
// ─────────────────────────────────────────────────────────────────────────────

function searchCoalesceKey(body) {
  return JSON.stringify({
    from: String(body.from || '').toUpperCase(),
    to: String(body.to || '').toUpperCase(),
    date: body.date || '',
    returnDate: body.returnDate || '',
    adt: Number(body.adt || body.adults || 1),
    chd: Number(body.chd || body.children || 0),
    inf: Number(body.inf || body.infants || 0),
    airline: String(body.airline || body.airlineCode || '').toUpperCase(),
    cabin: String(body.cabin || '').toLowerCase(),
  });
}

class HttpError extends Error {
  constructor(statusCode, message, details = {}) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function airportsVersion() {
  try {
    return Math.round(fs.statSync(AIRPORTS_JSON_PATH).mtimeMs);
  } catch (_) {
    return 0;
  }
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function sanitizeId(value) {
  return String(value || '')
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
}

function jsonHeaders(req, extra = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, Idempotency-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
    ...extra,
  };
  const origin = resolveCorsOrigin(req);
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function sendJson(res, statusCode, payload, req = res.req, extraHeaders = {}) {
  res.writeHead(statusCode, jsonHeaders(req, extraHeaders));
  res.end(JSON.stringify(payload, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new HttpError(413, 'Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new HttpError(400, `Invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function authTokenFromRequest(req) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey) return String(apiKey);
  const auth = req.headers.authorization || '';
  const match = String(auth).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

function assertAuthorized(req, pathname) {
  if (pathname === '/health' || pathname === '/airports') return;
  if (!API_KEY) {
    if (ALLOW_NO_AUTH) return;
    throw new HttpError(503, 'Backend auth not configured. Set BACKEND_API_KEY or BACKEND_ALLOW_NO_AUTH=true.');
  }
  if (authTokenFromRequest(req) !== API_KEY) {
    throw new HttpError(401, 'Invalid or missing API key. Use X-API-Key or Authorization: Bearer <key>.');
  }
}

function cleanCaches() {
  const now = Date.now();
  for (const [key, item] of searchCache.entries()) {
    if (!item || item.expiresAt <= now) searchCache.delete(key);
  }
  for (const [key, item] of bookingCache.entries()) {
    if (!item || item.expiresAt <= now) bookingCache.delete(key);
  }
  for (const [key, item] of idempotencyCache.entries()) {
    if (!item || item.expiresAt <= now) idempotencyCache.delete(key);
  }
  for (const [key, item] of ancillaryCache.entries()) {
    if (!item || item.expiresAt <= now) ancillaryCache.delete(key);
  }
  for (const [key, item] of searchResponseCache.entries()) {
    if (!item || item.expiresAt <= now) searchResponseCache.delete(key);
  }
}

function commandParams(body = {}) {
  return {
    from: body.from,
    to: body.to,
    date: body.date,
    returnDate: body.returnDate,
    airline: body.airline || body.airlineCode,
    time: body.time || body.departureTime,
    flightNumber: body.flightNumber || body.flight,
    returnTime: body.returnTime || body.returnDepartureTime,
    returnFlightNumber: body.returnFlightNumber || body.returnFlight,
    returnAirline: body.returnAirline || body.returnAirlineCode,
    directOnly: !!body.directOnly,
    adt: body.adt || body.adults || 1,
    chd: body.chd || body.children || 0,
    inf: body.inf || body.infants || 0,
    passenger: body.passenger,
    title: body.title,
    lastName: body.lastName,
    firstName: body.firstName,
    phone: body.phone || (body.contact && body.contact.phone),
    email: body.email || (body.contact && body.contact.email),
    contactName: body.contactName || (body.contact && body.contact.fullName),
    address: body.address || (body.contact && body.contact.address),
    extraInfo: body.extraInfo || (body.contact && body.contact.extraInfo),
    dryRun: !!body.dryRun,
    otp: body.otp,
  };
}

function requireFields(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === '');
  if (missing.length) {
    throw new HttpError(400, `Missing required fields: ${missing.join(', ')}`);
  }
}

function shouldRetryWithLogin(error) {
  if (!(error instanceof MuadiApiError)) return false;
  if (error.safeToRetry === false) return false;
  const code = error.data && String(error.data.code || '');
  const message = [
    error.message,
    error.data && error.data.message,
    error.data && error.data.code,
    error.path,
  ].filter(Boolean).join(' ');
  return error.status === 401 || code === '12' || code === '18' || /token|session time out/i.test(message);
}

function isRetryableValidationError(error) {
  if (!error || error.safeToRetry !== true) return false;
  const message = [
    error.message,
    error.data && error.data.message,
  ].filter(Boolean).join(' ');
  return /validation request failed/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withPromiseTimeout(promise, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      error.safeToRetry = true;
      reject(error);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function buildHoldPricingLogCtx(options = {}, sessionID, pnrs) {
  const startedAtMs = Date.now();
  return {
    holdId: options.holdId || null,
    sessionID: sessionID || null,
    pnrs: Array.isArray(pnrs) ? pnrs : [],
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
  };
}

function holdPricingLogMeta(holdLogCtx, details = {}) {
  return {
    holdId: holdLogCtx.holdId,
    sessionID: holdLogCtx.sessionID,
    pnrs: holdLogCtx.pnrs,
    startedAt: holdLogCtx.startedAt,
    ...details,
  };
}

function isTruthyFlag(value) {
  if (value === true) return true;
  const text = String(value || '').trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'yes';
}

function isFastHoldRequest(body = {}) {
  return isTruthyFlag(body.fastHold) || isTruthyFlag(body.skipPricingSync);
}

async function withAutoLogin(operation, body = {}) {
  if (body.freshLogin) {
    await runLoginCoalesced({ headless: body.showBrowser ? false : true });
  }

  const runWithProtection = async (client) => {
    try {
      return await operation(client);
    } catch (error) {
      if (!isBookingProtectionError(error) || error.safeToRetry === false) throw error;
      await verifyBookingProtection(client, error, { otp: body.otp });
      return operation(client);
    }
  };

  const runWithTransientRetry = async (client) => {
    try {
      return await runWithProtection(client);
    } catch (error) {
      if (!isRetryableValidationError(error)) throw error;
      await sleep(Number.parseInt(process.env.VALIDATION_RETRY_DELAY_MS || '700', 10) || 700);
      return runWithProtection(client);
    }
  };

  let client = new MuadiApiClient();
  try {
    return await runWithTransientRetry(client);
  } catch (error) {
    if (isBookingProtectionError(error) && error.safeToRetry !== false) {
      await verifyBookingProtection(client, error, { otp: body.otp });
      return operation(client);
    }
    if (!shouldRetryWithLogin(error)) throw error;

    // Try refresh first — cheap — before paying the full Playwright login.
    try {
      const refreshClient = client || new MuadiApiClient();
      const refreshed = await refreshClient.tryRefreshToken();
      if (refreshed) {
        client = new MuadiApiClient();
        // Re-schedule proactive refresh around the new expiry.
        setImmediate(() => scheduleProactiveRefresh());
        return runWithTransientRetry(client);
      }
    } catch (_) { /* fall through to full login */ }

    await runLoginCoalesced({ headless: body.showBrowser ? false : true });
    client = new MuadiApiClient();
    return runWithTransientRetry(client);
  }
}

function toIsoDateTime(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return text;

  let match = text.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4}).*?(\d{1,2}):(\d{2})/);
  if (match) {
    const [, d, m, y, hh, mm] = match;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}:00+07:00`;
  }

  match = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2}).*?(\d{1,2}):(\d{2})/);
  if (match) {
    const [, y, m, d, hh, mm] = match;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}:00+07:00`;
  }

  return text;
}

function hhmm(value) {
  const text = String(value || '');
  const match = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!match) return '';
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function parseDurationMinutes(value) {
  const text = String(value || '').trim();
  const match = text.match(/(\d{1,2}):(\d{2})/);
  if (!match) return 0;
  return Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10);
}

function diffMinutes(start, end) {
  const a = new Date(toIsoDateTime(start));
  const b = new Date(toIsoDateTime(end));
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000));
}

function segmentDuration(segment) {
  return parseDurationMinutes(segment.flightTime) || diffMinutes(segment.departDate, segment.arrivalDate);
}

function totalDuration(summary) {
  const segments = Array.isArray(summary.segments) ? summary.segments : [];
  if (!segments.length) return diffMinutes(summary.departDate, summary.arrivalDate);
  const full = diffMinutes(segments[0].departDate, segments[segments.length - 1].arrivalDate);
  if (full) return full;
  return segments.reduce((total, segment) => total + segmentDuration(segment), 0);
}

function airlineName(code) {
  const map = {
    VN: 'Vietnam Airlines',
    VJ: 'Vietjet Air',
    QH: 'Bamboo Airways',
    VU: 'Vietravel Airlines',
    '9G': '9G',
  };
  return map[String(code || '').toUpperCase()] || String(code || '').toUpperCase();
}

function dateTextForAbayParser(value) {
  const iso = toIsoDateTime(value);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getDate()).padStart(2, '0')}${months[d.getMonth()]}${d.getFullYear()}`;
}

function buildCompatDetailUrl(summary) {
  const segments = Array.isArray(summary.segments) ? summary.segments : [];
  if (!segments.length) return null;
  const encoded = segments.map((segment) => {
    const duration = segmentDuration(segment);
    const carrier = segment.carrierCode || summary.airline || '';
    const flightNo = String(segment.flightNumber || '').replace(/^\D+/, '');
    const fields = [
      segment.from || '',
      segment.to || '',
      carrier,
      `${carrier}${flightNo}`,
      hhmm(segment.departDate),
      hhmm(segment.arrivalDate),
      '',
      '',
      '',
      '',
      dateTextForAbayParser(segment.departDate),
      '',
      dateTextForAbayParser(segment.arrivalDate),
      '',
      '',
      `dur${String(Math.floor(duration / 60)).padStart(2, '0')}${String(duration % 60).padStart(2, '0')}`,
    ];
    return fields.join('-');
  }).join('|');
  return `https://www.abay.vn/namthanh?segoutbound=${encodeURIComponent(encoded)}`;
}

function fareBreakdown(summary) {
  return {
    baseAmount: Number(summary.fareADT || 0),
    taxesFees: Number(summary.taxADT || 0) + Number(summary.vatADT || 0) + Number(summary.issueFeeADT || 0),
    totalAmount: Number(summary.total || 0),
    currency: summary.currencyCode || 'VND',
  };
}

function buildFareId(fare, index) {
  const fareInfo = (fare && Array.isArray(fare.fareInfo) && fare.fareInfo[0]) || {};
  const rawParts = [
    fare && fare.id,
    fare && fare.class,
    fare && (fare.fareBasis || fareInfo.fareBasis),
    index,
  ].filter((part) => part !== undefined && part !== null && part !== '');

  return sanitizeId(rawParts.join('-')) || `fare_${index}`;
}

function firstText(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue;
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

function baggageInformationText(...values) {
  for (const value of values) {
    const items = Array.isArray(value) ? value : value ? [value] : [];
    for (const item of items) {
      if (item === undefined || item === null) continue;
      if (typeof item !== 'object') {
        const text = firstText(item);
        if (text) return text;
        continue;
      }

      const pieces = Number.parseInt(String(item.pieces || item.piece || item.quantity || ''), 10);
      const description = firstText(item.description, item.desc, item.name, item.text);
      if (Number.isFinite(pieces) && pieces > 0) {
        if (description && /pieces?|ki\u1ec7n/i.test(description)) return description;
        return `${pieces} ki\u1ec7n${description ? ` / ${description}` : ''}`;
      }
      if (description) return description;
    }
  }
  return '';
}

function fareMetadata(fare, flight) {
  const fareInfo = (fare && Array.isArray(fare.fareInfo) && fare.fareInfo[0]) || {};
  const baggage = (fare && fare.baggage) || (fareInfo && fareInfo.baggage) || {};
  const includedBaggage = fare && fare.includedBaggage || fareInfo.includedBaggage || {};
  const family = firstText(
    fare && fare.fareFamily,
    fare && fare.family,
    fare && fare.brandName,
    fare && fare.brand,
    fare && fare.productName,
    fareInfo.fareFamily,
    fareInfo.family,
    fareInfo.brandName,
    fareInfo.brand,
    fareInfo.productName,
    fareInfo.cabinClass
  );
  const cabinClass = firstText(fareInfo.cabinClass, fare && fare.cabinClass);
  const classCode = firstText(fare && fare.class, fareInfo.class);
  const businessText = `${family} ${cabinClass} ${classCode}`.toLowerCase();

  return {
    carryOnText: firstText(
      fare && fare.carryOnText,
      fare && fare.handBaggageText,
      fare && fare.handBaggage,
      fare && fare.cabinBaggage,
      fare && fare.carryOnBaggage,
      fareInfo.carryOnText,
      fareInfo.handBaggageText,
      fareInfo.handBaggage,
      fareInfo.cabinBaggage,
      fareInfo.carryOnBaggage,
      baggage.carryOn,
      baggage.hand,
      includedBaggage.carryOn
    ),
    checkedBaggageText: firstText(
      baggageInformationText(
        fare && fare.baggageInformations,
        fareInfo.baggageInformations,
        fare && fare.freeBaggage,
        fareInfo.freeBaggage,
        fare && fare.checkedBaggage,
        fareInfo.checkedBaggage,
        baggage.checked,
        baggage.free,
        includedBaggage.checked
      ),
      fare && fare.checkedBaggageText,
      fare && fare.freeBaggageText,
      fare && fare.freeBaggage,
      fare && fare.baggageText,
      fareInfo.checkedBaggageText,
      fareInfo.freeBaggageText,
      fareInfo.freeBaggage,
      fareInfo.baggageText,
      baggage.checked,
      baggage.free,
      includedBaggage.checked
    ),
    fareFamily: family,
    isBusiness: Boolean(fare && fare.isBusiness) || /\bbusiness\b|sky\s*boss|c[_\s-]*boss/.test(businessText),
  };
}

function toFareOption(fare, flight, index) {
  const summary = summarizeFlightFare(flight, fare);
  const metadata = fareMetadata(fare, flight);
  return {
    id: buildFareId(fare, index),
    class: summary.class,
    cabinClass: summary.cabinClass,
    fareBasis: summary.fareBasis,
    fareFamily: metadata.fareFamily,
    carryOnText: metadata.carryOnText,
    checkedBaggageText: metadata.checkedBaggageText,
    isBusiness: metadata.isBusiness,
    seatAvailable: summary.seatAvailable,
    currency: summary.currencyCode,
    fareBreakdown: fareBreakdown(summary),
    totalAmount: summary.total,
  };
}

function toPublicFlight(flight, fare, flightId, fareId) {
  const summary = summarizeFlightFare(flight, fare);
  const metadata = fareMetadata(fare, flight);
  const segments = Array.isArray(summary.segments) ? summary.segments : [];
  const first = segments[0] || {};
  const last = segments[segments.length - 1] || {};
  const fullFlightNumber = segments.length
    ? segments.map((segment) => `${segment.carrierCode || summary.airline || ''}${segment.flightNumber || ''}`).join(' + ')
    : summary.flightNumber;
  const total = Number(summary.total || 0);

  return {
    id: flightId,
    fareId,
    airline: airlineName(summary.airline),
    airlineCode: summary.airline,
    flightNumber: fullFlightNumber,
    departure: {
      airport: summary.from,
      airportName: summary.from,
      city: summary.from,
      time: toIsoDateTime(summary.departDate),
    },
    arrival: {
      airport: summary.to,
      airportName: summary.to,
      city: summary.to,
      time: toIsoDateTime(summary.arrivalDate),
    },
    duration: totalDuration(summary),
    stops: Math.max(0, segments.length - 1),
    price: {
      amount: total,
      currency: summary.currencyCode || 'VND',
      source: 'namthanh',
    },
    fareBreakdown: fareBreakdown(summary),
    priceUSD: computePriceUSD(total),
    sources: ['namthanh', 'muadi'],
    detailUrl: buildCompatDetailUrl(summary),
    namthanh: {
      flightId,
      fareId,
      systemName: summary.systemName,
      source: summary.source,
      class: summary.class,
      cabinClass: summary.cabinClass,
      fareBasis: summary.fareBasis,
      fareFamily: metadata.fareFamily,
      carryOnText: metadata.carryOnText,
      checkedBaggageText: metadata.checkedBaggageText,
      isBusiness: metadata.isBusiness,
      seatAvailable: summary.seatAvailable,
      route: summary.route,
      segments: segments.map((segment) => ({
        carrierCode: segment.carrierCode || summary.airline,
        flightNumber: `${segment.carrierCode || summary.airline || ''}${segment.flightNumber || ''}`,
        from: segment.from,
        to: segment.to,
        departDate: toIsoDateTime(segment.departDate),
        arrivalDate: toIsoDateTime(segment.arrivalDate),
        duration: segmentDuration(segment),
        airCraft: segment.airCraft || '',
      })),
      firstFlightNumber: first.flightNumber ? `${first.carrierCode || summary.airline || ''}${first.flightNumber}` : summary.flightNumber,
      lastFlightNumber: last.flightNumber ? `${last.carrierCode || summary.airline || ''}${last.flightNumber}` : summary.flightNumber,
    },
  };
}

const GDS_PAIR_SOURCE_RX = /^1[A-Z0-9]$/i;
const MAX_PAIR_COMPONENT_FLIGHTS = Number.isFinite(Number.parseInt(process.env.ROUNDTRIP_PAIR_COMPONENT_LIMIT || '40', 10))
  ? Number.parseInt(process.env.ROUNDTRIP_PAIR_COMPONENT_LIMIT || '40', 10)
  : 40;
const MAX_PAIR_OPTIONS_PER_SOURCE = Number.isFinite(Number.parseInt(process.env.ROUNDTRIP_PAIR_OPTIONS_PER_SOURCE || '80', 10))
  ? Number.parseInt(process.env.ROUNDTRIP_PAIR_OPTIONS_PER_SOURCE || '80', 10)
  : 80;
const MAX_EXACT_PAIR_OPTIONS_PER_SOURCE = Number.isFinite(Number.parseInt(process.env.ROUNDTRIP_EXACT_PAIR_OPTIONS_PER_SOURCE || '500', 10))
  ? Number.parseInt(process.env.ROUNDTRIP_EXACT_PAIR_OPTIONS_PER_SOURCE || '500', 10)
  : 500;

function publicFlightTotalAmount(flight) {
  if (flight && flight.fareBreakdown && Number.isFinite(Number(flight.fareBreakdown.totalAmount))) {
    return Number(flight.fareBreakdown.totalAmount);
  }
  if (flight && flight.price && Number.isFinite(Number(flight.price.amount))) {
    return Number(flight.price.amount);
  }
  return 0;
}

function normalizeRoundtripPairSource(value) {
  const source = String(value || '').trim().toUpperCase();
  if (!source) return '';
  if (GDS_PAIR_SOURCE_RX.test(source)) return source;

  const gdsMatch = source.match(/(?:^|[^A-Z0-9])(1[A-Z0-9])$/);
  if (gdsMatch && GDS_PAIR_SOURCE_RX.test(gdsMatch[1])) {
    return gdsMatch[1];
  }

  return '';
}

function roundtripPairSource(flight) {
  const rawSource = flight && flight.namthanh && flight.namthanh.source;
  const rawSystemName = flight && flight.namthanh && flight.namthanh.systemName;
  return normalizeRoundtripPairSource(rawSource) || normalizeRoundtripPairSource(rawSystemName);
}

function isPairableRoundtripSource(source) {
  return GDS_PAIR_SOURCE_RX.test(String(source || '').trim().toUpperCase());
}

function roundtripPairKey(flight) {
  const rawId = String(
    (flight && flight.namthanh && flight.namthanh.flightId) ||
    (flight && flight.id) ||
    ''
  ).trim();
  if (!rawId) return '';
  return rawId
    .replace(/^ret-\d+-/i, '')
    .replace(/^\d+-/i, '')
    .trim()
    .toUpperCase();
}

function buildPublicPairOption(outbound, inbound, source, index) {
  const outboundTotal = publicFlightTotalAmount(outbound);
  const inboundTotal = publicFlightTotalAmount(inbound);
  const totalAmount = outboundTotal + inboundTotal;
  const airlines = Array.from(
    new Set([outbound && outbound.airlineCode, inbound && inbound.airlineCode].filter(Boolean))
  );
  const systemName = String(
    (outbound && outbound.namthanh && outbound.namthanh.systemName) ||
    (inbound && inbound.namthanh && inbound.namthanh.systemName) ||
    source ||
    ''
  ).trim();

  return {
    id: sanitizeId(
      [source || systemName || 'pair', outbound && outbound.id, outbound && outbound.fareId, inbound && inbound.id, inbound && inbound.fareId, index]
        .filter(Boolean)
        .join('-')
    ) || `pair_${index}`,
    source: source || systemName || '',
    systemName: systemName || undefined,
    outboundFlightId: outbound && outbound.id,
    outboundFareId: outbound && outbound.fareId,
    inboundFlightId: inbound && inbound.id,
    inboundFareId: inbound && inbound.fareId,
    outbound,
    inbound,
    totalAmount,
    currency: 'VND',
    totalUSD: computePriceUSD(totalAmount),
    airlines,
    stops: Number(outbound && outbound.stops || 0) + Number(inbound && inbound.stops || 0),
  };
}

function buildRoundtripPairOptions(outboundFlights = [], returnFlights = []) {
  if (!Array.isArray(outboundFlights) || !Array.isArray(returnFlights) || !outboundFlights.length || !returnFlights.length) {
    return [];
  }

  const outboundBySource = new Map();
  const returnBySource = new Map();
  for (const flight of outboundFlights) {
    const source = roundtripPairSource(flight);
    if (!isPairableRoundtripSource(source)) continue;
    const list = outboundBySource.get(source) || [];
    list.push(flight);
    outboundBySource.set(source, list);
  }
  for (const flight of returnFlights) {
    const source = roundtripPairSource(flight);
    if (!isPairableRoundtripSource(source)) continue;
    const list = returnBySource.get(source) || [];
    list.push(flight);
    returnBySource.set(source, list);
  }

  const options = [];
  for (const [source, departures] of outboundBySource.entries()) {
    const returns = returnBySource.get(source);
    if (!returns || !returns.length) continue;

    const departureByKey = new Map();
    const returnByKey = new Map();
    for (const flight of departures) {
      const key = roundtripPairKey(flight);
      if (!key) continue;
      if (!departureByKey.has(key)) departureByKey.set(key, flight);
    }
    for (const flight of returns) {
      const key = roundtripPairKey(flight);
      if (!key) continue;
      if (!returnByKey.has(key)) returnByKey.set(key, flight);
    }

    const sharedKeys = [...departureByKey.keys()].filter((key) => returnByKey.has(key));
    const sourcePairs = [];

    if (sharedKeys.length) {
      sharedKeys.sort((a, b) => {
        const amountA = publicFlightTotalAmount(departureByKey.get(a)) + publicFlightTotalAmount(returnByKey.get(a));
        const amountB = publicFlightTotalAmount(departureByKey.get(b)) + publicFlightTotalAmount(returnByKey.get(b));
        if (amountA !== amountB) return amountA - amountB;
        return a.localeCompare(b);
      });

      for (const key of sharedKeys.slice(0, Math.max(1, MAX_EXACT_PAIR_OPTIONS_PER_SOURCE))) {
        sourcePairs.push(
          buildPublicPairOption(
            departureByKey.get(key),
            returnByKey.get(key),
            source,
            sourcePairs.length
          )
        );
      }
    } else {
      const departurePool = [...departures]
        .sort((a, b) => publicFlightTotalAmount(a) - publicFlightTotalAmount(b))
        .slice(0, Math.max(1, MAX_PAIR_COMPONENT_FLIGHTS));
      const returnPool = [...returns]
        .sort((a, b) => publicFlightTotalAmount(a) - publicFlightTotalAmount(b))
        .slice(0, Math.max(1, MAX_PAIR_COMPONENT_FLIGHTS));

      for (const outbound of departurePool) {
        for (const inbound of returnPool) {
          sourcePairs.push(buildPublicPairOption(outbound, inbound, source, sourcePairs.length));
        }
      }
    }

    sourcePairs.sort((a, b) => {
      if (a.totalAmount !== b.totalAmount) return a.totalAmount - b.totalAmount;
      return String(a.id).localeCompare(String(b.id));
    });
    const limit = sharedKeys.length
      ? Math.max(1, MAX_EXACT_PAIR_OPTIONS_PER_SOURCE)
      : Math.max(1, MAX_PAIR_OPTIONS_PER_SOURCE);
    options.push(...sourcePairs.slice(0, limit));
  }

  return options.sort((a, b) => {
    if (a.totalAmount !== b.totalAmount) return a.totalAmount - b.totalAmount;
    const sourceCompare = String(a.source || '').localeCompare(String(b.source || ''));
    if (sourceCompare !== 0) return sourceCompare;
    return String(a.id).localeCompare(String(b.id));
  });
}

function cacheSearch(result) {
  cleanCaches();
  const searchId = randomId('srch');
  const expiresAt = Date.now() + CACHE_TTL_MS;
  const entries = new Map();
  const publicFlights = [];
  const publicReturnFlights = [];

  const addFlightEntry = (flight, index, options = {}) => {
    const prefix = options.prefix || '';
    let picked;
    try {
      picked = cheapestFare(flight);
    } catch (error) {
      return;
    }

    const flightNo = summarizeFlightFare(flight, picked.fare).flightNumber;
    const baseFlightId = sanitizeId(flight.id || `${flight.airline || ''}-${flightNo}`) || 'flight';
    const flightId = sanitizeId(`${prefix}${index}-${baseFlightId}`) || `${prefix || 'flight_'}${index}`;
    const fareById = new Map();
    const fareOptions = (flight.priceInfo || [])
      .filter((fare) => fare && !fare.soldOut)
      .map((fare, fareIndex) => {
        const option = toFareOption(fare, flight, fareIndex);
        fareById.set(option.id, fare);
        return option;
      });
    const defaultFareId = buildFareId(picked.fare, (flight.priceInfo || []).indexOf(picked.fare));
    const publicFlight = {
      ...toPublicFlight(flight, picked.fare, flightId, defaultFareId),
      fareOptions,
    };

    entries.set(flightId, {
      flight,
      defaultFare: picked.fare,
      defaultFareId,
      fareById,
      publicFlight,
    });
    return publicFlight;
  };

  result.flights.forEach((flight, index) => {
    const publicFlight = addFlightEntry(flight, index);
    if (publicFlight) publicFlights.push(publicFlight);
  });
  (result.returnFlights || []).forEach((flight, index) => {
    const publicFlight = addFlightEntry(flight, index, { prefix: 'ret-' });
    if (publicFlight) publicReturnFlights.push(publicFlight);
  });

  const publicPairOptions = buildRoundtripPairOptions(publicFlights, publicReturnFlights);

  searchCache.set(searchId, {
    searchId,
    createdAt: Date.now(),
    expiresAt,
    request: result.request,
    sessionData: result.sessionData,
    entries,
    publicFlights,
    publicReturnFlights,
    publicPairOptions,
  });

  return {
    searchId,
    expiresAt,
    publicFlights,
    publicReturnFlights,
    publicPairOptions,
  };
}

function getCachedSearch(searchId) {
  cleanCaches();
  const cached = searchCache.get(searchId);
  if (!cached) {
    throw new HttpError(404, `Search not found or expired: ${searchId}`);
  }
  return cached;
}

function getCachedSelection(body) {
  const cached = getCachedSearch(body.searchId);
  const flightId = body.flightId || body.id;
  if (!flightId) throw new HttpError(400, 'Missing flightId.');
  const entry = cached.entries.get(flightId);
  if (!entry) throw new HttpError(404, `Flight not found in search cache: ${flightId}`);
  const fareId = body.fareId || entry.defaultFareId;
  const fare = entry.fareById.get(fareId) || entry.defaultFare;
  if (!fare) throw new HttpError(404, `Fare not found in search cache: ${fareId}`);
  return { cached, entry, flight: entry.flight, fare, flightId, fareId };
}

function publicSearchResponse(result, startedAt) {
  const cached = cacheSearch(result);
  const isRoundtrip = String(result && result.request && result.request.journeyType || '').toUpperCase() === 'RT';
  const departureResults = cached.publicFlights;
  const returnResults = cached.publicReturnFlights || [];
  const pairOptions = cached.publicPairOptions || [];
  return {
    success: true,
    searchId: cached.searchId,
    results: departureResults,
    departureResults: isRoundtrip ? departureResults : undefined,
    returnResults: isRoundtrip ? returnResults : undefined,
    pairOptions: isRoundtrip ? pairOptions : undefined,
    metadata: {
      totalResults: isRoundtrip
        ? (pairOptions.length || (departureResults.length + returnResults.length))
        : departureResults.length,
      departureCount: departureResults.length,
      returnCount: isRoundtrip ? returnResults.length : 0,
      pairCount: isRoundtrip ? pairOptions.length : 0,
      journeyType: isRoundtrip ? 'RT' : 'OW',
      searchTime: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      sourceUsed: 'namthanh',
      engine: 'MuadiDirect',
      sessionID: result.request.sessionID,
      expiresAt: new Date(cached.expiresAt).toISOString(),
      airlineErrors: result.errorsByAirline || {},
    },
  };
}

function contactFromBody(client, passenger, body = {}) {
  const user = (client && client.session && client.session.userInfo) || {};
  const agent = (client && client.session && client.session.agentInfo) || {};
  const contact = body.contact || {};
  const firstName = String(passenger && passenger.firstName || '').trim();
  const lastName = String(passenger && passenger.lastName || '').trim();
  return {
    email: contact.email || body.email || user.email || agent.agentEmail || '',
    fullName: contact.fullName || body.contactName || `${firstName} ${lastName}`.trim(),
    phoneNumber: contact.phone || body.phone || user.dienThoai || agent.telephone || '',
    address: contact.address || body.address || '',
    extraInfo: contact.extraInfo || body.extraInfo || '',
  };
}

function normalizePassengerType(value, fallback = 'ADT') {
  const type = String(value || fallback).trim().toUpperCase();
  if (type === 'CHD' || type === 'INF' || type === 'ADT') return type;
  return fallback;
}

function expectedPassengerType(index, body = {}) {
  const adults = Number.parseInt(body.adt || body.adults || '1', 10) || 1;
  const children = Number.parseInt(body.chd || body.children || '0', 10) || 0;
  if (index < adults) return 'ADT';
  if (index < adults + children) return 'CHD';
  return 'INF';
}

function normalizePassengerObject(rawPassenger, body = {}, index = 0) {
  const fallbackType = expectedPassengerType(index, body);
  if (typeof rawPassenger === 'string') {
    return parsePassengerName(rawPassenger, {
      ...body,
      id: `${fallbackType}${index + 1}`,
      type: fallbackType,
    });
  }

  if (!rawPassenger || typeof rawPassenger !== 'object') {
    throw new HttpError(400, `Invalid passenger at index ${index}.`);
  }

  const type = normalizePassengerType(rawPassenger.type, fallbackType);
  const fullName = rawPassenger.fullName || rawPassenger.name || '';
  const normalized = parsePassengerName(fullName, {
    title: rawPassenger.title || body.title,
    lastName: rawPassenger.lastName || body.lastName,
    firstName: rawPassenger.firstName || body.firstName,
    id: rawPassenger.id || `${type}${index + 1}`,
    type,
    dateOfBirth: rawPassenger.dateOfBirth || rawPassenger.birthday || '',
    birthday: rawPassenger.birthday || rawPassenger.dateOfBirth || '',
    loyaltyAirline: rawPassenger.loyaltyAirline || '',
    loyaltyNumber: rawPassenger.loyaltyNumber || '',
    goldCard: rawPassenger.goldCard || '',
    listLuggage: rawPassenger.listLuggage || [],
    ancillaryServices: rawPassenger.ancillaryServices || [],
    passport: rawPassenger.passport || undefined,
  });

  return {
    ...normalized,
    title: normalized.title || rawPassenger.title || (type === 'ADT' ? 'MR' : 'MSTR'),
    type,
  };
}

function hasPassengerCountInput(body = {}) {
  return ['adt', 'chd', 'inf', 'adults', 'children', 'infants'].some((field) => body[field] !== undefined && body[field] !== null);
}

function validatePassengerTypeCounts(passengers, body = {}) {
  if (!hasPassengerCountInput(body)) return;
  const expected = {
    ADT: Number.parseInt(body.adt || body.adults || '1', 10) || 1,
    CHD: Number.parseInt(body.chd || body.children || '0', 10) || 0,
    INF: Number.parseInt(body.inf || body.infants || '0', 10) || 0,
  };
  const actual = passengers.reduce((acc, passenger) => {
    const type = normalizePassengerType(passenger.type, 'ADT');
    acc[type] += 1;
    return acc;
  }, { ADT: 0, CHD: 0, INF: 0 });

  if (actual.ADT !== expected.ADT || actual.CHD !== expected.CHD || actual.INF !== expected.INF) {
    throw new HttpError(
      400,
      `Passenger type count mismatch. Expected ADT/CHD/INF=${expected.ADT}/${expected.CHD}/${expected.INF}, got ${actual.ADT}/${actual.CHD}/${actual.INF}.`
    );
  }
}

function passengersFromBody(body = {}) {
  const list = Array.isArray(body.passengers) ? body.passengers.filter(Boolean) : [];
  if (list.length > 0) {
    const passengers = list.map((item, index) => normalizePassengerObject(item, body, index));
    validatePassengerTypeCounts(passengers, body);
    return passengers;
  }

  const single = body.passenger;
  if (single !== undefined && single !== null && single !== '') {
    return [normalizePassengerObject(single, body, 0)];
  }

  if (body.lastName && body.firstName) {
    return [parsePassengerName('', body)];
  }

  throw new HttpError(400, 'Missing passenger list. Use passenger or passengers[].');
}

function displayPassenger(passenger) {
  if (!passenger) return '';
  return `${passenger.title || ''} ${passenger.lastName || ''}/${passenger.firstName || ''}`.trim();
}

function normalizeAncillaryResponse(response) {
  const raw = response && response.data ? response.data : response;
  const paxData = Array.isArray(raw && raw.paxData) ? raw.paxData : [];
  const paxTypeById = new Map(
    paxData.map((item) => [String(item.paxId || ''), normalizePassengerType(item.paxType, 'ADT')])
  );
  const segments = Array.isArray(raw && raw.segments) ? raw.segments : [];
  const routes = segments.map((segment) => {
    const paxServices = Array.isArray(segment.paxServices) ? segment.paxServices : [];
    const services = [];
    for (const pax of paxServices) {
      const paxId = String(pax.paxId || '');
      const paxType = paxTypeById.get(paxId) || normalizePassengerType(pax.paxType, 'ADT');
      for (const service of (Array.isArray(pax.services) ? pax.services : [])) {
        if (String(service.serviceType || '').toUpperCase() !== 'BAG') continue;
        if (!service.code || !service.key) continue;
        services.push({
          route: segment.route || '',
          segmentId: Number.parseInt(segment.segmentId || '0', 10) || 0,
          paxId,
          paxType,
          airline: raw.airline || segment.airline || '',
          serviceType: String(service.serviceType || '').toUpperCase(),
          code: service.code,
          description: service.description || '',
          price: Number(service.price || 0),
          currency: service.currency || 'VND',
          unit: service.unit || '',
          key: service.key,
        });
      }
    }
    return {
      route: segment.route || '',
      segmentId: Number.parseInt(segment.segmentId || '0', 10) || 0,
      airline: raw.airline || segment.airline || '',
      services,
    };
  }).filter((item) => item.services.length > 0);

  return {
    success: true,
    routes,
  };
}

function ancillaryPassengerCounts(body = {}) {
  return {
    adt: Number.parseInt(body.adt || body.adults || '1', 10) || 1,
    chd: Number.parseInt(body.chd || body.children || '0', 10) || 0,
    inf: Number.parseInt(body.inf || body.infants || '0', 10) || 0,
  };
}

function ancillaryCacheGet(cacheKey) {
  cleanCaches();
  const item = ancillaryCache.get(cacheKey);
  if (!item || item.expiresAt <= Date.now()) {
    ancillaryCache.delete(cacheKey);
    return null;
  }
  return item.value || null;
}

function ancillaryCacheSet(cacheKey, value) {
  ancillaryCache.set(cacheKey, {
    expiresAt: Date.now() + ANCILLARY_CACHE_TTL_MS,
    value,
  });
}

async function withAncillaryCache(cacheKey, loader) {
  const cached = ancillaryCacheGet(cacheKey);
  if (cached) return cached;

  const inflight = inflightAncillaries.get(cacheKey);
  if (inflight) return inflight;

  const promise = Promise.resolve()
    .then(loader)
    .then((value) => {
      ancillaryCacheSet(cacheKey, value);
      return value;
    })
    .finally(() => {
      inflightAncillaries.delete(cacheKey);
    });

  inflightAncillaries.set(cacheKey, promise);
  return promise;
}

function ancillaryCacheKeyForCachedSelection({ cached, flight, fare, flightId, fareId, body, mode = 'cached-selection' }) {
  const counts = ancillaryPassengerCounts(body);
  return JSON.stringify({
    mode,
    sessionID: cached && cached.request && cached.request.sessionID,
    searchId: cached && cached.searchId,
    flightId,
    fareId,
    airline: ancillaryAirlineText({ flight, fare }),
    route: ancillaryRouteText({ flight, fare }),
    fareBasis: ancillaryFareBasisText({ fare }),
    isNDC: !!(flight && flight.isNDC),
    typeBook: ancillaryTypeBookText({ flight, fare }),
    adt: counts.adt,
    chd: counts.chd,
    inf: counts.inf,
  });
}

function ancillaryCacheKeyForRoute(body = {}, priced = {}) {
  const counts = ancillaryPassengerCounts(body);
  return JSON.stringify({
    mode: 'route-based',
    from: body.from || '',
    to: body.to || '',
    date: body.date || '',
    returnDate: body.returnDate || '',
    airline: body.airline || body.airlineCode || '',
    flightNumber: body.flightNumber || body.flight || '',
    time: body.time || body.departureTime || '',
    returnAirline: body.returnAirline || body.returnAirlineCode || '',
    returnFlightNumber: body.returnFlightNumber || body.returnFlight || '',
    returnTime: body.returnTime || body.returnDepartureTime || '',
    route: ancillaryRouteText({
      flight: priced.flight,
      fare: priced.fare,
      returnFlight: priced.returnFlight,
      returnFare: priced.returnFare,
    }),
    fareBasis: [
      ancillaryFareBasisText({ fare: priced.fare }),
      ancillaryFareBasisText({ fare: priced.returnFare }),
    ].filter(Boolean).join('+'),
    isNDC: !!(priced.flight && priced.flight.isNDC),
    typeBook: ancillaryTypeBookText({ flight: priced.flight, fare: priced.fare }),
    adt: counts.adt,
    chd: counts.chd,
    inf: counts.inf,
  });
}

function sameAirlineCode(outboundFlight, inboundFlight) {
  const outboundCode = String(
    (outboundFlight && (outboundFlight.airlineCode || outboundFlight.airline)) || ''
  ).trim().toUpperCase();
  const inboundCode = String(
    (inboundFlight && (inboundFlight.airlineCode || inboundFlight.airline)) || ''
  ).trim().toUpperCase();
  return outboundCode && outboundCode === inboundCode ? outboundCode : '';
}

function selectionFromFlight(flight) {
  if (!flight || typeof flight !== 'object') return null;
  const nested = flight.namthanh || {};
  const searchId = flight.searchId || nested.searchId || '';
  const flightId = flight.id || nested.flightId || '';
  const fareId = flight.fareId || nested.fareId || '';
  if (!searchId || !flightId) return null;
  return { searchId, flightId, fareId };
}

function placeholderPassengersFromCounts(body = {}) {
  const adt = Number.parseInt(body.adt || body.adults || '1', 10) || 1;
  const chd = Number.parseInt(body.chd || body.children || '0', 10) || 0;
  const inf = Number.parseInt(body.inf || body.infants || '0', 10) || 0;
  const passengers = [];

  for (let i = 0; i < adt; i += 1) {
    passengers.push(parsePassengerName(`MR TEST ADULT ${i + 1}`, { id: `ADT${i + 1}`, type: 'ADT' }));
  }
  for (let i = 0; i < chd; i += 1) {
    passengers.push(parsePassengerName(`MSTR TEST CHILD ${i + 1}`, {
      id: `CHD${i + 1}`,
      type: 'CHD',
      birthday: '01-01-2016',
    }));
  }
  for (let i = 0; i < inf; i += 1) {
    passengers.push(parsePassengerName(`MSTR TEST INFANT ${i + 1}`, {
      id: `INF${i + 1}`,
      type: 'INF',
      birthday: '01-01-2025',
    }));
  }
  return passengers;
}

function resolvePassengersForAncillaries(body = {}) {
  const list = Array.isArray(body.passengers) ? body.passengers.filter(Boolean) : [];
  if (list.length > 0 || body.passenger) {
    return passengersFromBody(body);
  }
  return placeholderPassengersFromCounts(body);
}

function normalizePnrCode(value) {
  return String(value || '').trim().toUpperCase();
}

const TICKET_INFO_PENDING_STATUSES = new Set(['WAIT', 'LOADING']);

function pnrCodesFromTicketInfo(ticketInfo) {
  const data = ticketInfo && ticketInfo.data ? ticketInfo.data : {};
  const list = Array.isArray(data.listPNR) ? data.listPNR : [];
  return [...new Set(
    list
      .map((item) => normalizePnrCode(item && (item.pnr || item.message)))
      .filter(Boolean)
  )];
}

function parseBookingTimeMs(value) {
  const text = String(value || '').trim();
  const m = text.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return 0;
  const day = Number.parseInt(m[1], 10);
  const month = Number.parseInt(m[2], 10);
  const year = Number.parseInt(m[3], 10);
  const hour = Number.parseInt(m[4], 10);
  const minute = Number.parseInt(m[5], 10);
  const second = Number.parseInt(m[6] || '0', 10);
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function parseMoneyAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value || '').trim();
  if (!text) return NaN;
  const normalized = text.replace(/[^\d.-]/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : NaN;
}

function ticketInfoPnrMap(ticketInfo) {
  const data = ticketInfo && ticketInfo.data ? ticketInfo.data : {};
  const list = Array.isArray(data.listPNR) ? data.listPNR : [];
  const byPnr = new Map();
  for (const item of list) {
    const pnr = normalizePnrCode(item && (item.pnr || item.message));
    if (!pnr) continue;
    const currentStatus = String((item && item.status) || '').trim().toUpperCase();
    const currentPending = TICKET_INFO_PENDING_STATUSES.has(currentStatus);
    const previous = byPnr.get(pnr);
    if (!previous) {
      byPnr.set(pnr, item);
      continue;
    }
    const prevStatus = String((previous && previous.status) || '').trim().toUpperCase();
    const prevPending = TICKET_INFO_PENDING_STATUSES.has(prevStatus);
    if (prevPending && !currentPending) {
      byPnr.set(pnr, item);
    }
  }
  return byPnr;
}

function pricingByPnrFromTicketInfo(ticketInfo, targets, totalAmount, currency) {
  const targetList = [...new Set((targets || []).map(normalizePnrCode).filter(Boolean))];
  if (!targetList.length) return [];

  const byPnr = ticketInfoPnrMap(ticketInfo);
  const rowsWithOwnAmount = targetList
    .map((pnr) => {
      const item = byPnr.get(pnr);
      const amount = parseMoneyAmount(item && (item.totalPrice ?? item.totalAmount ?? item.amount));
      if (!Number.isFinite(amount) || amount < 0) return null;
      return {
        pnr,
        totalAmount: Math.round(amount),
        currency: (item && item.currencyCode) || currency || 'VND',
        bookingStatus: String((item && (item.status || item.message)) || ''),
        timelimit: String((item && (item.timelimit || item.timeLimit)) || ''),
      };
    })
    .filter(Boolean);

  if (rowsWithOwnAmount.length === targetList.length) {
    return rowsWithOwnAmount;
  }

  if (targetList.length === 1 && Number.isFinite(totalAmount) && totalAmount >= 0) {
    const item = byPnr.get(targetList[0]) || {};
    return [{
      pnr: targetList[0],
      totalAmount: Math.round(totalAmount),
      currency: (item && item.currencyCode) || currency || 'VND',
      bookingStatus: String((item && (item.status || item.message)) || ''),
      timelimit: String((item && (item.timelimit || item.timeLimit)) || ''),
    }];
  }

  return [];
}

function pricingSnapshotFromTicketInfo(ticketInfo, targets = []) {
  const data = ticketInfo && ticketInfo.data ? ticketInfo.data : {};
  const byPnr = ticketInfoPnrMap(ticketInfo);
  const targetList = [...new Set((targets || []).map(normalizePnrCode).filter(Boolean))];

  const unresolvedPnrs = targetList.filter((pnr) => {
    const item = byPnr.get(pnr);
    if (!item) return true;
    const status = String((item.status || '')).trim().toUpperCase();
    return TICKET_INFO_PENDING_STATUSES.has(status);
  });

  const totalAmountRaw = parseMoneyAmount(
    data.total ?? data.totalAmount ?? data.totalPrice ?? ticketInfo?.total ?? ticketInfo?.totalAmount
  );
  const hasTotalAmount = Number.isFinite(totalAmountRaw) && totalAmountRaw >= 0;
  const totalAmount = hasTotalAmount ? Math.round(totalAmountRaw) : undefined;
  const currency = data.currencyCode || data.currency || 'VND';
  const byPnrPricing = pricingByPnrFromTicketInfo(ticketInfo, targetList, totalAmount, currency);

  return {
    hasTotalAmount,
    totalAmount,
    currency,
    unresolvedPnrs,
    byPnr: byPnrPricing,
  };
}

function hasTicketInfoFastReturn(response) {
  const pnrCodes = pnrCodesFromTicketInfo(response);
  if (!pnrCodes.length) return false;
  const data = response && response.data ? response.data : {};
  const totalAmount = parseMoneyAmount(data.total ?? data.totalAmount ?? data.totalPrice);
  return Number.isFinite(totalAmount) && totalAmount >= 0;
}

function buildDeferredHoldPricing(result) {
  const ticketInfo = result && (result.ticketInfo || result.bookingResponse);
  const pnrCodes = pnrCodesFromTicketInfo(ticketInfo);
  const snapshot = pricingSnapshotFromTicketInfo(ticketInfo, pnrCodes);

  return {
    verified: false,
    source: 'deferred-after-fast-hold',
    currency: snapshot.currency || 'VND',
    totalAmount: snapshot.totalAmount,
    byPnr: snapshot.byPnr || [],
    unresolvedPnrs: pnrCodes,
    syncedAt: nowIso(),
    message: 'Pricing sync was deferred so PNR can be returned faster.',
  };
}

function pickPricingRowsByPnr(rows, targetSet) {
  const byPnr = new Map();
  for (const row of rows) {
    const pnr = normalizePnrCode(row && row.pnrCode);
    if (!pnr || !targetSet.has(pnr)) continue;

    const totalAmount = Number(row && row.totalPrice);
    if (!Number.isFinite(totalAmount) || totalAmount < 0) continue;

    const next = {
      pnr,
      totalAmount: Math.round(totalAmount),
      currency: 'VND',
      bookingId: Number.parseInt(row && row.id, 10) || undefined,
      bookingStatus: String((row && (row.bookingStatusNote || row.bookingStatus)) || ''),
      timelimit: String((row && row.timelimit) || ''),
      bookingTime: String((row && row.bookingTime) || ''),
    };

    const prev = byPnr.get(pnr);
    if (!prev) {
      byPnr.set(pnr, next);
      continue;
    }

    const prevTime = parseBookingTimeMs(prev.bookingTime);
    const nextTime = parseBookingTimeMs(next.bookingTime);
    const prevId = Number(prev.bookingId || 0);
    const nextId = Number(next.bookingId || 0);
    if (nextTime > prevTime || (nextTime === prevTime && nextId >= prevId)) {
      byPnr.set(pnr, next);
    }
  }
  return byPnr;
}

function pricingErrorMessage(error) {
  if (!error) return '';
  if (error instanceof MuadiApiError) {
    const code = error.data && error.data.code ? ` code ${error.data.code}` : '';
    const status = error.status ? ` status ${error.status}` : '';
    const msg = error.message || 'Muadi pricing sync error';
    return `${msg}${status}${code}`.trim();
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function ancillaryRouteText(bookRequest = {}) {
  const listRoutes = Array.isArray(bookRequest.listRoutes) ? bookRequest.listRoutes : [];
  return listRoutes
    .map((route) => {
      const segments = Array.isArray(route.listRoute) ? route.listRoute : [];
      if (segments.length) {
        const first = segments[0] || {};
        const last = segments[segments.length - 1] || {};
        return `${first.from || route.from || ''}-${last.to || route.to || ''}`;
      }
      return `${route.from || ''}-${route.to || ''}`;
    })
    .filter(Boolean)
    .join('|');
}

function ancillaryFareBasisText(bookRequest = {}, fare) {
  const listRoutes = Array.isArray(bookRequest.listRoutes) ? bookRequest.listRoutes : [];
  const fromRequest = listRoutes
    .flatMap((route) => (Array.isArray(route.listRoute) ? route.listRoute : []))
    .map((segment) => segment && segment.jPrice && segment.jPrice.fareBasis)
    .filter(Boolean);
  if (fromRequest.length) return [...new Set(fromRequest)].join('|');

  const fareInfo = fare && Array.isArray(fare.fareInfo) ? fare.fareInfo : [];
  const fromFare = fareInfo
    .map((item) => item && item.fareBasis)
    .filter(Boolean);
  return fromFare.length ? [...new Set(fromFare)].join('|') : '';
}

function ancillaryAirlineText(bookRequest = {}, flight, body = {}) {
  const listRoutes = Array.isArray(bookRequest.listRoutes) ? bookRequest.listRoutes : [];
  const routeAirline = listRoutes.map((route) => route && route.airline).find(Boolean);
  const firstCarrier = listRoutes
    .flatMap((route) => (Array.isArray(route.listRoute) ? route.listRoute : []))
    .map((segment) => segment && segment.carrierCode)
    .find(Boolean);
  return String(
    routeAirline ||
    firstCarrier ||
    (flight && flight.airline) ||
    body.airline ||
    body.returnAirline ||
    ''
  ).toUpperCase();
}

function ancillaryTypeBookText(bookRequest = {}, flight, fare) {
  const listRoutes = Array.isArray(bookRequest.listRoutes) ? bookRequest.listRoutes : [];
  return String(
    listRoutes.map((route) => route && route.typeBook).find(Boolean) ||
    (flight && flight.typeOfBook) ||
    (fare && fare.typeOfBook) ||
    ''
  ).toUpperCase();
}

function ancillaryLogMeta({
  mode = '',
  body = {},
  bookRequest = {},
  flight = null,
  fare = null,
  searchId = '',
  flightId = '',
  fareId = '',
  error = null,
} = {}) {
  return {
    mode,
    airline: ancillaryAirlineText(bookRequest, flight, body),
    route: ancillaryRouteText(bookRequest) || `${body.from || ''}-${body.to || ''}`.replace(/^-|-$/g, ''),
    fareBasis: ancillaryFareBasisText(bookRequest, fare),
    isNDC: !!(bookRequest.isNDC || (flight && flight.isNDC)),
    typeBook: ancillaryTypeBookText(bookRequest, flight, fare),
    sessionID: Number.parseInt(bookRequest.sessionID || body.sessionID || '0', 10) || 0,
    searchId: String(searchId || body.searchId || ''),
    flightId: String(flightId || body.flightId || ''),
    fareId: String(fareId || body.fareId || ''),
    adt: Number.parseInt(bookRequest.adt || body.adt || body.adults || '1', 10) || 1,
    chd: Number.parseInt(bookRequest.chd || body.chd || body.children || '0', 10) || 0,
    inf: Number.parseInt(bookRequest.inf || body.inf || body.infants || '0', 10) || 0,
    error: pricingErrorMessage(error),
  };
}

function logAncillaryFailure(meta = {}) {
  logger.warn('[ancillaries] failed', ancillaryLogMeta(meta));
}

async function fetchListBookingRowsViaApi(client) {
  const listing = await client.post('management/list-booking', undefined, {
    encrypt: false,
    version: null,
    safeToRetry: true,
    timeout: 20_000,
  });
  return Array.isArray(listing && listing.data) ? listing.data : [];
}

async function reconcileHoldPricingByTicketInfo(client, options = {}) {
  const sessionID = Number.parseInt(options.sessionID || '0', 10) || 0;
  const targets = [...new Set((options.pnrCodes || []).map(normalizePnrCode).filter(Boolean))];
  const holdLogCtx = buildHoldPricingLogCtx(options, sessionID, targets);
  if (!targets.length) {
    return {
      verified: false,
      source: 'booking/ticket-info-by-id',
      currency: 'VND',
      byPnr: [],
      unresolvedPnrs: [],
      syncedAt: nowIso(),
      message: 'No PNR found to reconcile pricing.',
    };
  }

  const overrideMaxAttempts = Number.parseInt(options.maxAttempts, 10);
  const maxAttempts = Number.isFinite(overrideMaxAttempts) && overrideMaxAttempts > 0
    ? overrideMaxAttempts
    : Number.isFinite(HOLD_PRICING_TICKETINFO_ATTEMPTS) && HOLD_PRICING_TICKETINFO_ATTEMPTS > 0
      ? HOLD_PRICING_TICKETINFO_ATTEMPTS
      : 3;
  const overrideInitialDelayMs = Number.parseInt(options.initialDelayMs, 10);
  let delayMs = Number.isFinite(overrideInitialDelayMs) && overrideInitialDelayMs >= 0
    ? overrideInitialDelayMs
    : Number.isFinite(HOLD_PRICING_TICKETINFO_INITIAL_DELAY_MS) && HOLD_PRICING_TICKETINFO_INITIAL_DELAY_MS > 0
      ? HOLD_PRICING_TICKETINFO_INITIAL_DELAY_MS
      : 250;
  const requestTimeoutMs = Number.parseInt(options.requestTimeoutMs, 10);

  let latestInfo = options.initialTicketInfo || null;
  let latestSnapshot = pricingSnapshotFromTicketInfo(latestInfo, targets);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const canUseCurrent = !!latestInfo
      && (latestSnapshot.hasTotalAmount || latestSnapshot.unresolvedPnrs.length === 0);

    if (!canUseCurrent) {
      if (!sessionID) break;
      try {
        latestInfo = await withPromiseTimeout(
          client.getTicketInfoBySessionId(sessionID),
          requestTimeoutMs,
          'booking/ticket-info-by-id'
        );
        latestSnapshot = pricingSnapshotFromTicketInfo(latestInfo, targets);
        lastError = null;
      } catch (error) {
        lastError = error;
        latestInfo = null;
        latestSnapshot = pricingSnapshotFromTicketInfo(null, targets);
        if (error instanceof MuadiApiError && error.status === 401) {
          try {
            await client.tryRefreshToken();
          } catch (_) { /* ignore */ }
        }
      }
    }

    logger.info('[hold-pricing]', holdPricingLogMeta(holdLogCtx, {
      source: 'booking/ticket-info-by-id',
      attempt,
      elapsedMs: Date.now() - holdLogCtx.startedAtMs,
      verified: latestSnapshot.hasTotalAmount,
      totalAmount: latestSnapshot.hasTotalAmount ? latestSnapshot.totalAmount : null,
      unresolvedPnrs: latestSnapshot.unresolvedPnrs,
    }));

    if (latestSnapshot.hasTotalAmount) {
      return {
        verified: true,
        source: 'booking/ticket-info-by-id',
        currency: latestSnapshot.currency,
        totalAmount: latestSnapshot.totalAmount,
        byPnr: latestSnapshot.byPnr,
        unresolvedPnrs: latestSnapshot.unresolvedPnrs,
        syncedAt: nowIso(),
        message: latestSnapshot.unresolvedPnrs.length
          ? 'Some PNR details are still syncing; total is confirmed from ticket-info-by-id.'
          : undefined,
      };
    }

    if (attempt < maxAttempts) {
      await sleep(delayMs);
      delayMs = Math.min(Math.round(delayMs * 1.5), 1500);
    }
  }

  const failureMessage = pricingErrorMessage(lastError);
  logger.error('[hold-pricing] give up', holdPricingLogMeta(holdLogCtx, {
    source: 'booking/ticket-info-by-id',
    attempt: maxAttempts,
    elapsedMs: Date.now() - holdLogCtx.startedAtMs,
    verified: false,
    totalAmount: latestSnapshot.hasTotalAmount ? latestSnapshot.totalAmount : null,
    unresolvedPnrs: latestSnapshot.unresolvedPnrs.length ? latestSnapshot.unresolvedPnrs : targets,
    message: failureMessage || 'Ticket pricing is not ready yet from booking/ticket-info-by-id.',
  }));
  return {
    verified: false,
    source: 'booking/ticket-info-by-id',
    currency: latestSnapshot.currency || 'VND',
    totalAmount: latestSnapshot.hasTotalAmount ? latestSnapshot.totalAmount : undefined,
    byPnr: latestSnapshot.byPnr,
    unresolvedPnrs: latestSnapshot.unresolvedPnrs.length ? latestSnapshot.unresolvedPnrs : targets,
    syncedAt: nowIso(),
    message: failureMessage || 'Ticket pricing is not ready yet from booking/ticket-info-by-id.',
  };
}

async function reconcileHoldPricingByPnr(client, pnrCodes, options = {}) {
  const targets = [...new Set((pnrCodes || []).map(normalizePnrCode).filter(Boolean))];
  const targetSet = new Set(targets);
  const holdLogCtx = buildHoldPricingLogCtx(options, Number.parseInt(options.sessionID || '0', 10) || 0, targets);
  if (!targets.length) {
    return {
      verified: false,
      source: 'management/list-booking-fallback',
      currency: 'VND',
      byPnr: [],
      unresolvedPnrs: [],
      syncedAt: nowIso(),
      message: 'No PNR found to reconcile pricing.',
    };
  }

  const overrideMaxAttempts = Number.parseInt(options.maxAttempts, 10);
  const maxAttempts = Number.isFinite(overrideMaxAttempts) && overrideMaxAttempts > 0
    ? overrideMaxAttempts
    : Number.isFinite(HOLD_PRICING_FALLBACK_ATTEMPTS) && HOLD_PRICING_FALLBACK_ATTEMPTS > 0
      ? HOLD_PRICING_FALLBACK_ATTEMPTS
      : 2;
  const overrideInitialDelayMs = Number.parseInt(options.initialDelayMs, 10);
  let delayMs = Number.isFinite(overrideInitialDelayMs) && overrideInitialDelayMs >= 0
    ? overrideInitialDelayMs
    : Number.isFinite(HOLD_PRICING_FALLBACK_INITIAL_DELAY_MS) && HOLD_PRICING_FALLBACK_INITIAL_DELAY_MS > 0
      ? HOLD_PRICING_FALLBACK_INITIAL_DELAY_MS
      : 300;

  let latestByPnr = new Map();
  let lastError = null;

  logger.warn('[hold-pricing] fallback to list-booking', holdPricingLogMeta(holdLogCtx, {
    source: 'management/list-booking-fallback',
  }));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let rows = [];
    try {
      rows = await fetchListBookingRowsViaApi(client);
      lastError = null;
    } catch (error) {
      lastError = error;

      if (error instanceof MuadiApiError && error.status === 401) {
        try {
          await client.tryRefreshToken();
        } catch (_) { /* ignore */ }
      }
    }

    if (rows.length) {
      latestByPnr = pickPricingRowsByPnr(rows, targetSet);
      const unresolved = targets.filter((pnr) => !latestByPnr.has(pnr));
      const byPnr = targets.map((pnr) => latestByPnr.get(pnr)).filter(Boolean);
      const totalAmount = byPnr.reduce((sum, item) => sum + Number(item && item.totalAmount || 0), 0);
      logger.info('[hold-pricing]', holdPricingLogMeta(holdLogCtx, {
        source: 'management/list-booking-fallback',
        attempt,
        elapsedMs: Date.now() - holdLogCtx.startedAtMs,
        verified: unresolved.length === 0,
        totalAmount: unresolved.length === 0 ? totalAmount : null,
        unresolvedPnrs: unresolved,
      }));
      if (unresolved.length === 0) {
        return {
          verified: true,
          source: 'management/list-booking-fallback',
          currency: 'VND',
          totalAmount,
          byPnr,
          unresolvedPnrs: [],
          syncedAt: nowIso(),
        };
      }
    } else {
      logger.info('[hold-pricing]', holdPricingLogMeta(holdLogCtx, {
        source: 'management/list-booking-fallback',
        attempt,
        elapsedMs: Date.now() - holdLogCtx.startedAtMs,
        verified: false,
        totalAmount: null,
        unresolvedPnrs: targets.filter((pnr) => !latestByPnr.has(pnr)),
      }));
    }

    if (attempt < maxAttempts) {
      await sleep(delayMs);
      delayMs = Math.min(Math.round(delayMs * 1.4), 1200);
    }
  }

  const byPnr = targets.map((pnr) => latestByPnr.get(pnr)).filter(Boolean);
  const unresolvedPnrs = targets.filter((pnr) => !latestByPnr.has(pnr));
  const failureMessage = pricingErrorMessage(lastError);

  logger.error('[hold-pricing] give up', holdPricingLogMeta(holdLogCtx, {
    source: 'management/list-booking-fallback',
    attempt: maxAttempts,
    elapsedMs: Date.now() - holdLogCtx.startedAtMs,
    verified: false,
    totalAmount: null,
    unresolvedPnrs,
    message: failureMessage || `Pricing has not synced for ${unresolvedPnrs.length}/${targets.length} PNR(s).`,
  }));

  return {
    verified: false,
    source: 'management/list-booking-fallback',
    currency: 'VND',
    byPnr,
    unresolvedPnrs,
    syncedAt: nowIso(),
    message: failureMessage || `Pricing has not synced for ${unresolvedPnrs.length}/${targets.length} PNR(s).`,
  };
}

function buildDryRunPricing(result, summary) {
  const estimate = Number(result.total || (summary && summary.flight && summary.flight.total) || 0);
  return {
    verified: false,
    source: 'estimate',
    currency: (summary && summary.flight && summary.flight.currencyCode) || 'VND',
    totalAmount: Number.isFinite(estimate) ? estimate : 0,
    byPnr: [],
    unresolvedPnrs: [],
    syncedAt: nowIso(),
    message: 'Dry-run mode: total is estimated from fare snapshot.',
  };
}

async function finalizeHoldResultWithPricing(result, body = {}, options = {}) {
  if (!result?.dryRun && isFastHoldRequest(body)) {
    return {
      ...result,
      pricing: buildDeferredHoldPricing(result),
    };
  }

  return enrichHoldResultWithPricing(result, body, options);
}

async function enrichHoldResultWithPricing(result, body = {}, options = {}) {
  if (!result || typeof result !== 'object') return result;
  const summary = result.dryRun
    ? {
      sessionID: result.request && result.request.sessionID,
      passenger: displayPassenger(result.passenger),
      flight: result.summary,
      pnrs: [],
    }
    : summarizeHoldResult(result);

  if (result.dryRun) {
    return {
      ...result,
      pricing: buildDryRunPricing(result, summary),
    };
  }

  const pnrCodes = pnrCodesFromTicketInfo(result.ticketInfo || result.bookingResponse);
  const sessionID = Number.parseInt(
    (summary && summary.sessionID) || (result.request && result.request.sessionID) || body.sessionID || '0',
    10
  ) || 0;
  const basePricing = {
    verified: false,
    source: 'booking/ticket-info-by-id',
    currency: (summary && summary.flight && summary.flight.currencyCode) || 'VND',
    byPnr: [],
    unresolvedPnrs: pnrCodes,
    syncedAt: nowIso(),
  };

  if (!pnrCodes.length) {
    return {
      ...result,
      pricing: {
        ...basePricing,
        message: 'Booking created but no PNR was found to reconcile pricing.',
      },
    };
  }

  let ticketInfoPricing = null;
  let ticketInfoError = null;
  try {
    ticketInfoPricing = options.client
      ? await reconcileHoldPricingByTicketInfo(options.client, {
        sessionID,
        pnrCodes,
        initialTicketInfo: result.ticketInfo || result.bookingResponse,
        holdId: options.holdId,
        maxAttempts: options.ticketInfoMaxAttempts,
        initialDelayMs: options.ticketInfoInitialDelayMs,
        requestTimeoutMs: options.ticketInfoRequestTimeoutMs,
      })
      : await withAutoLogin(
        (client) => reconcileHoldPricingByTicketInfo(client, {
          sessionID,
          pnrCodes,
          initialTicketInfo: result.ticketInfo || result.bookingResponse,
          holdId: options.holdId,
          maxAttempts: options.ticketInfoMaxAttempts,
          initialDelayMs: options.ticketInfoInitialDelayMs,
          requestTimeoutMs: options.ticketInfoRequestTimeoutMs,
        }),
        { ...body, freshLogin: false, showBrowser: false }
      );
  } catch (error) {
    ticketInfoError = error;
  }

  if (ticketInfoPricing && ticketInfoPricing.verified) {
    return { ...result, pricing: ticketInfoPricing };
  }

  let fallbackPricing = null;
  let fallbackError = null;
  try {
    fallbackPricing = options.client
      ? await reconcileHoldPricingByPnr(options.client, pnrCodes, {
        holdId: options.holdId,
        sessionID,
        maxAttempts: options.fallbackMaxAttempts,
        initialDelayMs: options.fallbackInitialDelayMs,
      })
      : await withAutoLogin(
        (client) => reconcileHoldPricingByPnr(client, pnrCodes, {
          holdId: options.holdId,
          sessionID,
          maxAttempts: options.fallbackMaxAttempts,
          initialDelayMs: options.fallbackInitialDelayMs,
        }),
        { ...body, freshLogin: false, showBrowser: false }
      );
  } catch (error) {
    fallbackError = error;
  }

  if (fallbackPricing && fallbackPricing.verified) {
    return { ...result, pricing: fallbackPricing };
  }

  const messages = [
    ticketInfoPricing && ticketInfoPricing.message,
    pricingErrorMessage(ticketInfoError),
    fallbackPricing && fallbackPricing.message,
    pricingErrorMessage(fallbackError),
  ].filter(Boolean);

  return {
    ...result,
    pricing: {
      ...(fallbackPricing || ticketInfoPricing || basePricing),
      verified: false,
      message: messages.length ? messages.join(' | ') : 'Pricing sync failed after hold.',
    },
  }
}

function normalizeHoldSummary(result, holdId) {
  const passengerText = Array.isArray(result.passengers) && result.passengers.length > 0
    ? result.passengers.map(displayPassenger).filter(Boolean).join(', ')
    : '';
  const summary = result.dryRun
    ? {
      sessionID: result.request.sessionID,
      passenger: passengerText || displayPassenger(result.passenger),
      flight: result.summary,
      pnrs: [],
    }
    : summarizeHoldResult(result);
  const pricing = result && result.pricing && typeof result.pricing === 'object'
    ? result.pricing
    : undefined;
  const verifiedTotal = Number(pricing && pricing.verified ? pricing.totalAmount : NaN);
  const estimatedTotal = Number(result.total || (summary.flight && summary.flight.total) || 0);
  const totalAmount = result.dryRun
    ? (Number.isFinite(estimatedTotal) ? estimatedTotal : 0)
    : (Number.isFinite(verifiedTotal) ? verifiedTotal : (Number.isFinite(estimatedTotal) ? estimatedTotal : null));

  return {
    success: true,
    holdId,
    dryRun: !!result.dryRun,
    sessionID: summary.sessionID,
    passenger: summary.passenger,
    flight: summary.flight,
    totalAmount,
    currency: (pricing && pricing.currency) || (summary.flight && summary.flight.currencyCode),
    pricing,
    pnrs: summary.pnrs,
    protectionVerified: !!result.protectionVerified,
  };
}

async function handleHealth(options = {}) {
  let session = { exists: fs.existsSync(config.paths.sessionFile), ok: false };
  let token = { decodable: false };
  if (session.exists) {
    try {
      const state = readStorageState(config.paths.sessionFile);
      token = tokenStatus(state.accessToken);
      session = {
        exists: true,
        ok: !token.decodable || !token.expired,
        user: state.userInfo && (state.userInfo.userName || state.userInfo.username || state.userInfo.email || ''),
        agent: state.agentInfo && (state.agentInfo.agentCode || state.agentInfo.agentName || ''),
      };
    } catch (error) {
      session = { exists: true, ok: false, error: error.message };
    }
  }

  let probe = null;
  if (options.probe && session.ok) {
    const probeStarted = Date.now();
    try {
      const client = new MuadiApiClient();
      const rate = await client.getExchangeRate();
      probe = { ok: true, latencyMs: Date.now() - probeStarted, exchangeRate: rate };
    } catch (err) {
      probe = {
        ok: false,
        latencyMs: Date.now() - probeStarted,
        error: err && err.message,
      };
    }
  }

  let ocr = { configured: false, reachable: false, url: config.ddddocr && config.ddddocr.apiUrl };
  if (ocr.url) {
    ocr.configured = true;
    try {
      ocr.reachable = await Promise.race([
        ocrClient.healthCheck(),
        new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
    } catch (_) {
      ocr.reachable = false;
    }
  }

  const exchangeRateStatus = exchangeRateCache && exchangeRateCache.value
    ? {
        value: exchangeRateCache.value,
        fetchedAt: new Date(exchangeRateCache.fetchedAt).toISOString(),
        stale: Date.now() - exchangeRateCache.fetchedAt >= EXCHANGE_RATE_TTL_MS,
      }
    : { value: null, fallback: EXCHANGE_RATE_FALLBACK };

  const ok = !!session.ok && (!ocr.configured || ocr.reachable) && (!probe || probe.ok);
  const sessionMgr = sessionManagerStatus();

  return {
    ok,
    service: 'namthanh-auto-login',
    time: nowIso(),
    auth: API_KEY ? 'api-key-required' : (ALLOW_NO_AUTH ? 'disabled-local' : 'misconfigured'),
    session: { ...session, token },
    sessionManager: {
      loginInProgress: sessionMgr.loginInProgress,
      refreshScheduled: sessionMgr.refreshScheduled,
      lastRefreshAt: sessionMgr.lastRefreshAt,
      lastRefreshOk: sessionMgr.lastRefreshOk,
    },
    probe,
    ocr,
    login: getLoginStatus(),
    exchangeRate: exchangeRateStatus,
    cache: {
      searches: searchCache.size,
      searchResponses: searchResponseCache.size,
      bookings: bookingCache.size,
      ancillaries: ancillaryCache.size,
      inflightAncillaries: inflightAncillaries.size,
      inflightSearch: inflightSearch.size,
    },
    endpoints: [
      'GET /health',
      'GET /health?probe=true',
      'GET /airports',
      'GET /session/ensure',
      'GET /config/exchange-rate',
      'POST /auth/login',
      'POST /flights/search',
      'POST /flights/search/stream',
      'POST /flights/price',
      'POST /bookings/ancillaries',
      'POST /bookings/hold',
      'GET /bookings/:sessionID',
    ],
  };
}

async function handleLogin(body) {
  await runLoginCoalesced({ headless: body.showBrowser ? false : true });
  return { success: true, message: 'Login OK. Session was saved.', time: nowIso() };
}

// Lightweight user-triggered warm-up: FE gọi khi user vừa mở trang để đảm bảo
// session sẵn sàng trước khi user bấm tìm vé. Luôn trả lời < 100ms.
// - Nếu session còn tươi (>= SESSION_ENSURE_MIN_TTL giây) → { ready: true, warm: true }
// - Nếu đang login → { ready: false, warming: true }
// - Nếu chưa warm → kick off background warm-up, trả { ready: false, warming: true }
const SESSION_ENSURE_MIN_TTL_SEC = Number.parseInt(process.env.SESSION_ENSURE_MIN_TTL_SEC || '120', 10);

async function handleSessionEnsure() {
  const started = Date.now();
  const mgr = sessionManagerStatus();

  const warmEnough =
    mgr.token &&
    mgr.token.decodable &&
    !mgr.token.expired &&
    Number(mgr.token.expiresInSeconds || 0) >= SESSION_ENSURE_MIN_TTL_SEC;

  if (warmEnough) {
    return {
      ready: true,
      warm: true,
      warming: false,
      token: mgr.token,
      latencyMs: Date.now() - started,
    };
  }

  if (mgr.loginInProgress) {
    return {
      ready: false,
      warm: false,
      warming: true,
      reason: 'login-in-progress',
      latencyMs: Date.now() - started,
    };
  }

  // Fire-and-forget. warmUpSession đã có đủ logic: refresh-first, fall back to login,
  // mutex chống chạy song song, reschedule timer sau khi xong.
  warmUpSession().catch((err) => console.error('[ensure] warmUp error:', err && err.message));

  return {
    ready: false,
    warm: false,
    warming: true,
    reason: mgr.token && mgr.token.decodable ? 'expired-or-stale' : 'no-session',
    latencyMs: Date.now() - started,
  };
}

async function handleExchangeRate(body = {}) {
  const now = Date.now();
  const force = !!body.force;
  const fresh = exchangeRateCache.value && now - exchangeRateCache.fetchedAt < EXCHANGE_RATE_TTL_MS;
  if (!force && fresh) {
    return {
      success: true,
      rate: exchangeRateCache.value,
      cached: true,
      fetchedAt: new Date(exchangeRateCache.fetchedAt).toISOString(),
      ttlSeconds: Math.max(0, Math.floor((EXCHANGE_RATE_TTL_MS - (now - exchangeRateCache.fetchedAt)) / 1000)),
    };
  }
  if (exchangeRateInflight) return exchangeRateInflight;

  exchangeRateInflight = withAutoLogin(async (client) => {
    const value = await client.getExchangeRate();
    exchangeRateCache = { value, fetchedAt: Date.now() };
    return {
      success: true,
      rate: value,
      cached: false,
      fetchedAt: new Date(exchangeRateCache.fetchedAt).toISOString(),
      ttlSeconds: Math.floor(EXCHANGE_RATE_TTL_MS / 1000),
    };
  }, body).finally(() => { exchangeRateInflight = null; });

  return exchangeRateInflight;
}

async function handleAirports() {
  return {
    airports: getAirportsList(),
    version: airportsVersion(),
  };
}

async function handleSearch(body) {
  requireFields(body, ['from', 'to', 'date']);
  const startedAt = Date.now();
  const key = searchCoalesceKey(body);
  const cached = searchResponseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  if (cached) searchResponseCache.delete(key);

  const existing = inflightSearch.get(key);
  if (existing) return existing;

  const promise = withAutoLogin(async (client) => {
    const result = await searchJourney(commandParams(body), { client });
    const response = publicSearchResponse(result, startedAt);
    searchResponseCache.set(key, {
      data: response,
      expiresAt: Date.now() + SEARCH_RESPONSE_CACHE_TTL_MS,
    });
    return response;
  }, body).finally(() => {
    inflightSearch.delete(key);
  });
  inflightSearch.set(key, promise);
  return promise;
}

async function handleSearchStream(body, req, res) {
  requireFields(body, ['from', 'to', 'date']);

  const headers = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Vary': 'Origin',
  };
  const origin = resolveCorsOrigin(req);
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  res.writeHead(200, headers);

  let clientClosed = false;
  req.on('close', () => {
    clientClosed = true;
  });

  function writeEvent(data, eventName = '') {
    if (clientClosed || res.writableEnded || res.destroyed) return false;
    if (eventName) res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  }

  function writeError(message) {
    if (writeEvent({ error: message }, 'error')) res.end();
  }

  let client;
  try {
    client = await withAutoLogin((currentClient) => Promise.resolve(currentClient), body);
  } catch (error) {
    writeError(`Login failed: ${error && error.message ? error.message : String(error)}`);
    return;
  }

  const params = commandParams(body);
  let request;
  let sessionData;
  let airlines;

  try {
    request = buildSearchRequest(params);
    const createSession = await client.createSession(request);
    sessionData = createSession.data || {};
    request.sessionID = sessionData.sessionID;

    const normalizedSignIns = (sessionData.listSignIn || [])
      .map((item) => (typeof item === 'string' ? item : (item && (item.airline || item.airlineCode || item.code || item.value)) || ''))
      .map((item) => String(item).trim().toUpperCase())
      .filter(Boolean);
    const requestedAirline = params.airline ? String(params.airline).trim().toUpperCase() : null;
    const fallbackAirlines = ['VN', 'VJ', 'QH', 'VU', '9G'];
    airlines = requestedAirline
      ? [requestedAirline]
      : (normalizedSignIns.length ? normalizedSignIns : fallbackAirlines);

    writeEvent({ type: 'session', airlines, sessionId: sessionData.sessionID });
  } catch (error) {
    writeError(`Session failed: ${error && error.message ? error.message : String(error)}`);
    return;
  }

  let completedCount = 0;
  await Promise.all(
    airlines.map(async (airline) => {
      try {
        const response = await client.searchFlightByAirline(airline, request);
        const partialResult = {
          client,
          request,
          createSession: { data: sessionData },
          sessionData,
          signIns: airlines,
          byAirline: { [airline]: [] },
          errorsByAirline: {},
          flights: [],
          returnFlights: [],
        };

        if (request.journeyType === 'RT') {
          const { departureFlights, returnFlights: foundReturnFlights } = flightsFromSearchResponseRT(response);
          partialResult.byAirline[airline] = departureFlights;
          partialResult.flights = departureFlights;
          partialResult.returnFlights = foundReturnFlights;
        } else {
          const foundFlights = flightsFromSearchResponse(response);
          partialResult.byAirline[airline] = foundFlights;
          partialResult.flights = foundFlights;
        }

        const cached = cacheSearch(partialResult);
        completedCount += 1;
        writeEvent({
          type: 'airline_result',
          airline,
          searchId: cached.searchId,
          results: cached.publicFlights,
          departureResults: cached.publicFlights,
          returnResults: cached.publicReturnFlights,
          pairOptions: cached.publicPairOptions,
          completedCount,
          totalCount: airlines.length,
        });
      } catch (error) {
        completedCount += 1;
        writeEvent({
          type: 'airline_error',
          airline,
          error: error && error.message ? error.message : String(error),
          completedCount,
          totalCount: airlines.length,
        });
      }
    })
  );

  writeEvent({ type: 'done', totalCount: airlines.length, completedCount });
  if (!res.writableEnded && !res.destroyed) res.end();
}

async function handlePrice(body) {
  if (body.searchId) {
    const { flight, fare, flightId, fareId } = getCachedSelection(body);
    const publicFlight = toPublicFlight(flight, fare, flightId, fareId);
    return {
      success: true,
      searchId: body.searchId,
      flightId,
      fareId,
      flight: publicFlight,
      fareBreakdown: publicFlight.fareBreakdown,
      summary: summarizeFlightFare(flight, fare),
    };
  }

  requireFields(body, ['from', 'to', 'date']);
  const result = await withAutoLogin(
    (client) => priceFlight(commandParams(body), { client }),
    body
  );
  const cached = cacheSearch(result);
  const cachedSearch = getCachedSearch(cached.searchId);
  const selectedEntry = [...cachedSearch.entries.values()].find((entry) => entry.flight === result.flight);
  const publicFlight = selectedEntry
    ? toPublicFlight(result.flight, result.fare, selectedEntry.publicFlight.id, selectedEntry.defaultFareId)
    : toPublicFlight(result.flight, result.fare, 'flight_0', 'fare_0');

  return {
    success: true,
    searchId: cached.searchId,
    flightId: publicFlight.id,
    fareId: publicFlight.fareId,
    flight: publicFlight,
    fareBreakdown: publicFlight.fareBreakdown,
    summary: result.summary,
  };
}

function mergeAncillaryRoutes(items = []) {
  return items.reduce((all, item) => all.concat(Array.isArray(item.routes) ? item.routes : []), []);
}

async function ancillariesFromCachedSelection(body, client) {
  const { cached, flight, fare, flightId, fareId } = getCachedSelection(body);
  const passengers = resolvePassengersForAncillaries(body);
  const leadPassenger = passengers[0];
  const contact = contactFromBody(client, leadPassenger, body);
  const bookRequest = buildBookRequest({
    client,
    request: cached.request,
    flight,
    fare,
    passengers,
    passenger: leadPassenger,
    contact,
    isExportNow: false,
  });
  const cacheKey = ancillaryCacheKeyForCachedSelection({ cached, flight, fare, flightId, fareId, body });
  return withAncillaryCache(cacheKey, async () => {
    try {
      const raw = await client.getAncillaries(buildAncillariesRequest(bookRequest));
      return {
        ...normalizeAncillaryResponse(raw),
        searchId: cached.searchId,
        flightId,
        fareId,
      };
    } catch (error) {
      logAncillaryFailure({
        mode: 'cached-selection',
        body,
        bookRequest,
        flight,
        fare,
        searchId: cached.searchId,
        flightId,
        fareId,
        error,
      });
      throw error;
    }
  });
}

async function ancillariesByRoute(body, client) {
  requireFields(body, ['from', 'to', 'date']);
  let priced = null;
  let passengers = [];
  let leadPassenger = null;
  let contact = null;
  let bookRequest = null;
  try {
    priced = await priceFlight(commandParams(body), { client });
    passengers = resolvePassengersForAncillaries(body);
    leadPassenger = passengers[0];
    contact = contactFromBody(client, leadPassenger, body);
    bookRequest = buildBookRequest({
      client,
      request: priced.request,
      flight: priced.flight,
      fare: priced.fare,
      passengers,
      passenger: leadPassenger,
      contact,
      isExportNow: false,
    });
    const cacheKey = ancillaryCacheKeyForRoute(body, priced);
    return withAncillaryCache(cacheKey, async () => {
      try {
        const raw = await client.getAncillaries(buildAncillariesRequest(bookRequest));
        return normalizeAncillaryResponse(raw);
      } catch (error) {
        logAncillaryFailure({
          mode: 'route-based',
          body,
          bookRequest: bookRequest || {},
          flight: priced && priced.flight,
          fare: priced && priced.fare,
          error,
        });
        throw error;
      }
    });
  } catch (error) {
    throw error;
  }
}

async function ancillariesFromCachedRoundtrip(body, client) {
  const outboundSelection = selectionFromFlight(body.outbound || body.flight || null);
  const inboundSelection = selectionFromFlight(body.inbound || null);
  if (!outboundSelection || !inboundSelection) {
    throw new HttpError(400, 'Missing outbound or inbound cached selection.');
  }

  const outbound = getCachedSelection({ ...body, ...outboundSelection });
  const inbound = getCachedSelection({ ...body, ...inboundSelection });
  const sessionID = outbound.cached && outbound.cached.request && outbound.cached.request.sessionID;
  const inboundSessionID = inbound.cached && inbound.cached.request && inbound.cached.request.sessionID;
  if (!sessionID || sessionID !== inboundSessionID) {
    throw new HttpError(400, 'Roundtrip ancillary cache requires matching sessionID.');
  }

  const passengers = resolvePassengersForAncillaries(body);
  const leadPassenger = passengers[0];
  const contact = contactFromBody(client, leadPassenger, body);
  const bookRequest = buildBookRequest({
    client,
    request: outbound.cached.request,
    flight: outbound.flight,
    fare: outbound.fare,
    returnFlight: inbound.flight,
    returnFare: inbound.fare,
    passengers,
    passenger: leadPassenger,
    contact,
    isExportNow: false,
  });
  const cacheKey = ancillaryCacheKeyForCachedSelection({
    cached: outbound.cached,
    flight: outbound.flight,
    fare: outbound.fare,
    flightId: `${outbound.flightId}+${inbound.flightId}`,
    fareId: `${outbound.fareId}+${inbound.fareId}`,
    body,
    mode: 'cached-roundtrip',
  });

  return withAncillaryCache(cacheKey, async () => {
    try {
      const raw = await client.getAncillaries(buildAncillariesRequest(bookRequest));
      return {
        ...normalizeAncillaryResponse(raw),
        splitRoundtrip: false,
        searchId: outbound.cached.searchId,
        flightId: outbound.flightId,
        fareId: outbound.fareId,
        returnFlightId: inbound.flightId,
        returnFareId: inbound.fareId,
      };
    } catch (error) {
      logAncillaryFailure({
        mode: 'cached-roundtrip',
        body,
        bookRequest,
        flight: outbound.flight,
        fare: outbound.fare,
        searchId: outbound.cached.searchId,
        flightId: `${outbound.flightId}+${inbound.flightId}`,
        fareId: `${outbound.fareId}+${inbound.fareId}`,
        error,
      });
      throw error;
    }
  });
}

async function handleAncillaries(body) {
  return withAutoLogin(async (client) => {
    const outboundSelection = selectionFromFlight(body.outbound || body.flight || null);
    const inboundSelection = selectionFromFlight(body.inbound || null);

    if (outboundSelection && inboundSelection) {
      if (sameAirlineCode(body.outbound || body.flight, body.inbound)) {
        try {
          return await ancillariesFromCachedRoundtrip(body, client);
        } catch (error) {
          logger.warn('[ancillaries] same-airline roundtrip fallback to split', {
            airline: sameAirlineCode(body.outbound || body.flight, body.inbound),
            route: `${body.outbound?.departure?.airport || body.flight?.departure?.airport || ''}-${body.outbound?.arrival?.airport || body.flight?.arrival?.airport || ''}|${body.inbound?.departure?.airport || ''}-${body.inbound?.arrival?.airport || ''}`,
            error: error && error.message ? error.message : String(error),
          });
        }
      }

      const [outbound, inbound] = await Promise.all([
        ancillariesFromCachedSelection({
          ...body,
          ...outboundSelection,
        }, client),
        ancillariesFromCachedSelection({
          ...body,
          ...inboundSelection,
        }, client),
      ]);
      return {
        success: true,
        splitRoundtrip: true,
        routes: mergeAncillaryRoutes([outbound, inbound]),
        legs: { outbound, inbound },
      };
    }

    if (body.searchId || outboundSelection) {
      const selection = body.searchId ? body : { ...body, ...outboundSelection };
      return ancillariesFromCachedSelection(selection, client);
    }

    return ancillariesByRoute(body, client);
  }, body);
}

async function holdFromCachedSelection(body) {
  const { cached, flight, fare, flightId, fareId } = getCachedSelection(body);
  const passengers = passengersFromBody(body);
  const passenger = passengers[0];
  const holdId = randomId('hold');
  const fastHold = isFastHoldRequest(body);

  const resultWithPricing = await withAutoLogin(async (client) => {
    const contact = contactFromBody(client, passenger, body);
    const summary = summarizeFlightFare(flight, fare);
    const bookRequest = buildBookRequest({
      client,
      request: cached.request,
      flight,
      fare,
      passenger,
      passengers,
      contact,
      isExportNow: false,
    });
    const finalBookRequest = body.dryRun ? bookRequest : await refreshBookRequestLuggage(client, bookRequest);

    let result;
    if (body.dryRun) {
      result = {
        request: cached.request,
        flight,
        fare,
        summary,
        passenger,
        passengers,
        bookRequest: finalBookRequest,
        dryRun: true,
      };
      return finalizeHoldResultWithPricing(result, body, { client, holdId });
    }

    const protectedBooking = await createBookingWithProtection(client, finalBookRequest, { otp: body.otp });
    const bookingResponse = protectedBooking.bookingResponse;
    let ticketInfo = bookingResponse;
    if (!hasCompletePnrResponse(bookingResponse) && !(fastHold && hasAnyPnrResponse(bookingResponse))) {
      try {
        ticketInfo = await pollTicketInfoLocal(
          client,
          finalBookRequest.sessionID,
          body.pollAttempts ?? (fastHold ? 1 : undefined),
          body.pollDelayMs ?? (fastHold ? 0 : undefined)
        );
      } catch (error) {
        logger.warn('[hold] ticket-info polling failed after create-booking; returning booking response fallback', {
          sessionID: finalBookRequest.sessionID,
          error: error && error.message ? error.message : String(error),
        });
      }
    }
    result = {
      request: cached.request,
      flight,
      fare,
      summary,
      passenger,
      passengers,
      bookRequest: finalBookRequest,
      bookingResponse,
      protectionVerified: protectedBooking.protectionVerified,
      ticketInfo,
      dryRun: false,
    };
    return finalizeHoldResultWithPricing(result, body, { client, holdId });
  }, body);

  const response = {
    ...normalizeHoldSummary(resultWithPricing, holdId),
    searchId: cached.searchId,
    flightId,
    fareId,
  };
  bookingCache.set(holdId, { createdAt: Date.now(), expiresAt: Date.now() + BOOKING_CACHE_TTL_MS, response });
  return response;
}

async function pollTicketInfoLocal(client, sessionID, attempts, delayMs) {
  const maxAttempts = Number.parseInt(attempts || process.env.POLL_MAX_ATTEMPTS || '10', 10);
  const maxWallClockMs = Number.parseInt(process.env.POLL_MAX_WALL_CLOCK_MS || '30000', 10);
  const circuitBreakerThreshold = Number.parseInt(process.env.POLL_CIRCUIT_BREAKER_THRESHOLD || '3', 10);
  let waitMs = Number.parseInt(delayMs || '500', 10);
  let lastResponse = null;
  let consecutiveErrors = 0;
  let lastError = null;
  const startedAt = Date.now();

  for (let index = 0; index < maxAttempts; index += 1) {
    if (Date.now() - startedAt > maxWallClockMs) {
      const err = new Error(`pollTicketInfo exceeded wall-clock ${maxWallClockMs}ms (attempt ${index}/${maxAttempts})`);
      err.safeToRetry = false;
      if (lastError) err.cause = lastError;
      throw err;
    }
    try {
      lastResponse = await client.getTicketInfoBySessionId(sessionID);
      consecutiveErrors = 0;
    } catch (error) {
      if (!isBookingProtectionError(error)) {
        consecutiveErrors += 1;
        lastError = error;
        if (consecutiveErrors >= circuitBreakerThreshold) {
          const err = new Error(`pollTicketInfo circuit breaker tripped after ${consecutiveErrors} consecutive errors: ${error.message}`);
          err.cause = error;
          err.safeToRetry = false;
          throw err;
        }
        // non-protection API error: wait and retry within threshold
        if (index < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          waitMs = Math.min(Math.round(waitMs * 1.4), 2000);
        }
        continue;
      }
      try {
        await verifyBookingProtection(client, error);
      } catch (verifyError) {
        if (verifyError && typeof verifyError === 'object') verifyError.safeToRetry = false;
        throw verifyError;
      }
      lastResponse = await client.getTicketInfoBySessionId(sessionID);
      consecutiveErrors = 0;
    }
    if (hasCompletePnrResponse(lastResponse) || hasTicketInfoFastReturn(lastResponse)) return lastResponse;
    if (index < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      waitMs = Math.min(Math.round(waitMs * 1.4), 2000);
    }
  }
  return lastResponse;
}

async function handleHold(body, req) {
  const idempotencyKey = req.headers['idempotency-key'] || body.idempotencyKey;
  if (idempotencyKey) {
    cleanCaches();
    const cached = idempotencyCache.get(idempotencyKey);
    if (cached) return { ...cached.response, idempotentReplay: true };
  }

  let response;
  if (body.searchId) {
    response = await holdFromCachedSelection(body);
  } else {
    const fastHold = isFastHoldRequest(body);
    requireFields(body, ['from', 'to', 'date']);
    const passengers = passengersFromBody(body);
    const passenger = passengers[0];
    const holdId = randomId('hold');
    const params = {
      ...commandParams(body),
      passengerObject: passenger,
      passengersObject: passengers,
    };
    const resultWithPricing = await withAutoLogin(async (client) => {
      const result = await holdFlight(params, {
        client,
        dryRun: !!body.dryRun,
        fastHold,
        skipPricingSync: fastHold,
        pollAttempts: body.pollAttempts ?? (fastHold ? 1 : undefined),
        pollDelayMs: body.pollDelayMs ?? (fastHold ? 0 : undefined),
        otp: body.otp,
      });
      return finalizeHoldResultWithPricing(result, body, { client, holdId });
    }, body);
    response = normalizeHoldSummary(resultWithPricing, holdId);
    bookingCache.set(holdId, { createdAt: Date.now(), expiresAt: Date.now() + BOOKING_CACHE_TTL_MS, response });
  }

  if (idempotencyKey && !body.dryRun) {
    idempotencyCache.set(idempotencyKey, {
      createdAt: Date.now(),
      expiresAt: Date.now() + BOOKING_CACHE_TTL_MS,
      response,
    });
  }

  return response;
}

async function handleBookingStatus(sessionID, body = {}) {
  if (!sessionID) throw new HttpError(400, 'Missing sessionID.');
  return withAutoLogin(async (client) => {
    const ticketInfo = await pollTicketInfoLocal(client, sessionID, body.pollAttempts || 1, body.pollDelayMs || 0);
    const data = ticketInfo && ticketInfo.data ? ticketInfo.data : {};
    return {
      success: true,
      sessionID,
      pnrs: (data.listPNR || []).map((item) => ({
        airline: item.airline,
        pnr: item.pnr || item.message || '',
        status: item.status,
        from: item.dep || item.from,
        to: item.ret || item.to,
        timelimit: item.timelimit || item.timeLimit || '',
        message: item.message || '',
      })),
      rawStatus: data.status || data.message || '',
    };
  }, body);
}

async function dispatch(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, jsonHeaders(req));
    res.end();
    return;
  }

  assertAuthorized(req, pathname);

  if (req.method === 'GET' && pathname === '/health') {
    const probe = url.searchParams.get('probe') === 'true';
    sendJson(res, 200, await handleHealth({ probe }));
    return;
  }

  if (req.method === 'GET' && pathname === '/airports') {
    sendJson(
      res,
      200,
      await handleAirports(),
      req,
      { 'Cache-Control': 'public, max-age=86400, s-maxage=86400' }
    );
    return;
  }

  if (req.method === 'GET' && pathname === '/config/exchange-rate') {
    sendJson(res, 200, await handleExchangeRate({}));
    return;
  }

  if (req.method === 'GET' && pathname === '/flights/lowest-fare') {
    const result = await handleLowestFareRequest({
      origin: url.searchParams.get('origin'),
      destination: url.searchParams.get('destination'),
    });
    sendJson(res, result.statusCode, result.payload, req, result.headers);
    return;
  }

  if (req.method === 'GET' && pathname === '/session/ensure') {
    sendJson(res, 200, await handleSessionEnsure());
    return;
  }

  const body = req.method === 'GET' ? {} : await readBody(req);

  if (req.method === 'POST' && pathname === '/config/exchange-rate') {
    sendJson(res, 200, await handleExchangeRate(body));
    return;
  }

  if (req.method === 'POST' && pathname === '/auth/login') {
    sendJson(res, 200, await handleLogin(body));
    return;
  }

  if (req.method === 'POST' && pathname === '/flights/search/stream') {
    await handleSearchStream(body, req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/flights/search') {
    sendJson(res, 200, await handleSearch(body));
    return;
  }

  if (req.method === 'POST' && pathname === '/flights/price') {
    sendJson(res, 200, await handlePrice(body));
    return;
  }

  if (req.method === 'POST' && pathname === '/bookings/ancillaries') {
    sendJson(res, 200, await handleAncillaries(body));
    return;
  }

  if (req.method === 'POST' && pathname === '/bookings/hold') {
    sendJson(res, 200, await handleHold(body, req));
    return;
  }

  const bookingMatch = pathname.match(/^\/bookings\/([^/]+)$/);
  if (req.method === 'GET' && bookingMatch) {
    sendJson(res, 200, await handleBookingStatus(decodeURIComponent(bookingMatch[1]), body));
    return;
  }

  throw new HttpError(404, `Route not found: ${req.method} ${pathname}`);
}

const EXPOSE_ERROR_DETAILS = String(process.env.BACKEND_EXPOSE_ERROR_DETAILS || '').toLowerCase() === 'true'
  || process.env.NODE_ENV !== 'production';

const SENSITIVE_FIELD_RX = /(token|authorization|cookie|password|secret|apikey|api_key|session)/i;

function redactDetails(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactDetails(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_FIELD_RX.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactDetails(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 1000) return value.slice(0, 1000) + '…';
  return value;
}

function safeUpstreamMessage(error) {
  const raw = error && (error.data && (error.data.message || error.data.msg))
    ? String(error.data.message || error.data.msg)
    : String(error.message || 'Upstream error');
  // Strip tokens / long base64 blobs that sometimes show up in upstream messages
  return raw.replace(/[A-Za-z0-9_-]{40,}/g, '[REDACTED]').slice(0, 400);
}

function errorPayload(error) {
  const payload = {
    success: false,
    error: EXPOSE_ERROR_DETAILS ? (error.message || String(error)) : safeUpstreamMessage(error),
  };
  if (error instanceof MuadiApiError) {
    payload.type = 'MuadiApiError';
    payload.status = error.status;
    payload.safeToRetry = error.safeToRetry;
    if (EXPOSE_ERROR_DETAILS) {
      payload.path = error.path;
      payload.details = redactDetails(error.data);
    }
    if (isBookingProtectionError(error)) payload.otpRequired = true;
  } else if (error instanceof HttpError) {
    payload.type = 'HttpError';
    if (EXPOSE_ERROR_DETAILS) payload.details = redactDetails(error.details);
  }
  return payload;
}

function statusForError(error) {
  if (error instanceof HttpError) return error.statusCode;
  if (error instanceof MuadiApiError) {
    if (error.status === 401) return 401;
    if (error.status && error.status >= 400 && error.status < 500) return 502;
    return 502;
  }
  return 500;
}

function createServer() {
  return http.createServer((req, res) => {
    res.req = req;
    dispatch(req, res).catch((error) => {
      sendJson(res, statusForError(error), errorPayload(error), req);
    });
  });
}

async function shutdown(server, signal) {
  console.log(`[shutdown] ${signal} received — closing server...`);
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  try { await closeSingletonBrowser(); } catch (_) { /* ignore */ }
  server.close(() => {
    console.log('[shutdown] HTTP server closed');
    process.exit(0);
  });
  // Hard exit after 10s if something is stuck
  setTimeout(() => {
    console.warn('[shutdown] Force exit after 10s');
    process.exit(1);
  }, 10_000).unref();
}

if (require.main === module) {
  const server = createServer();
  server.listen(DEFAULT_PORT, () => {
    console.log(`Nam Thanh backend API listening on http://localhost:${DEFAULT_PORT}`);
    console.log(`Auth: ${API_KEY ? 'API key required' : (ALLOW_NO_AUTH ? 'DISABLED (BACKEND_ALLOW_NO_AUTH=true, local dev only)' : 'misconfigured')}`);
    console.log('Endpoints: /health, /airports, /config/exchange-rate, /auth/login, /flights/search, /flights/search/stream, /flights/lowest-fare, /flights/price, /bookings/ancillaries, /bookings/hold');

    // Kick off warm-up so the first real user request doesn't pay login cost.
    warmUpSession().catch((err) => console.error('[warmup] unexpected:', err && err.message));
  });

  process.on('SIGTERM', () => shutdown(server, 'SIGTERM'));
  process.on('SIGINT',  () => shutdown(server, 'SIGINT'));
}

module.exports = {
  createServer,
  toPublicFlight,
  cacheSearch,
  searchCache,
  searchResponseCache,
  reconcileHoldPricingByTicketInfo,
  reconcileHoldPricingByPnr,
  enrichHoldResultWithPricing,
  normalizeHoldSummary,
};
