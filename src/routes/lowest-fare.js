'use strict';

const { MuadiApiClient } = require('../muadi-client');

const LOWEST_FARE_TTL_MS = Number.parseInt(process.env.LOWEST_FARE_CACHE_TTL_SECONDS || '300', 10) * 1000;
const cache = new Map();

function normalizeIata(value) {
  return String(value || '').trim().toUpperCase();
}

function isValidIata(value) {
  return /^[A-Z]{3}$/.test(normalizeIata(value));
}

function cacheKey(origin, destination) {
  return `${origin}-${destination}`;
}

function unwrapLowestFareResponse(response) {
  return response && response.data !== undefined ? response.data : response;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFareDay(value) {
  return isPlainObject(value)
    && Number.isFinite(Number(value.day))
    && Number.isFinite(Number(value.month))
    && Number.isFinite(Number(value.year))
    && Number.isFinite(Number(value.fareAmount));
}

function isFareBucketMap(value) {
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  if (entries.length === 0) return false;

  return entries.some(([key, days]) => {
    if (!/^\d{1,2}-\d{4}$/.test(key) || !Array.isArray(days)) return false;
    return days.some(isFareDay);
  });
}

function normalizeFareBuckets(value) {
  if (!isPlainObject(value)) return {};

  const buckets = {};
  for (const [key, days] of Object.entries(value)) {
    if (!/^\d{1,2}-\d{4}$/.test(key) || !Array.isArray(days)) continue;

    const normalizedDays = days
      .filter(isFareDay)
      .map((day) => ({
        ...day,
        day: Number(day.day),
        month: Number(day.month),
        year: Number(day.year),
        fareAmount: Number(day.fareAmount),
      }));

    if (normalizedDays.length > 0) {
      buckets[key] = normalizedDays;
    }
  }

  return buckets;
}

function normalizeLowestFarePayload({ origin, destination, raw, cachedAt }) {
  const data = unwrapLowestFareResponse(raw) || {};
  const directBuckets = isFareBucketMap(data) ? normalizeFareBuckets(data) : null;
  const depart = directBuckets || normalizeFareBuckets(data.depart);
  const returnData = directBuckets || normalizeFareBuckets(data.return);

  return {
    route: { origin, destination },
    depart,
    return: returnData,
    currency: data.currency || data.currencyCode || 'VND',
    cachedAt,
    ttlSeconds: Math.max(0, Math.floor(LOWEST_FARE_TTL_MS / 1000)),
  };
}

function getCached(origin, destination, now = Date.now()) {
  const entry = cache.get(cacheKey(origin, destination));
  if (!entry || entry.expiresAt <= now) {
    if (entry) cache.delete(cacheKey(origin, destination));
    return null;
  }
  return entry.data;
}

async function handleLowestFareRequest(query, options = {}) {
  const origin = normalizeIata(query.origin);
  const destination = normalizeIata(query.destination);

  if (!isValidIata(origin) || !isValidIata(destination)) {
    return {
      statusCode: 400,
      payload: { error: 'INVALID_IATA' },
    };
  }

  const now = Date.now();
  const cached = getCached(origin, destination, now);
  if (cached) {
    console.log(`[lowest-fare] cache hit ${origin}-${destination}`);
    return {
      statusCode: 200,
      payload: cached,
      headers: { 'Cache-Control': 'private, max-age=60' },
    };
  }

  try {
    const client = options.client || new MuadiApiClient();
    const raw = await client.searchLowestFare({ origin, destination, currencyCode: 'VND' });
    const payload = normalizeLowestFarePayload({
      origin,
      destination,
      raw,
      cachedAt: new Date(now).toISOString(),
    });

    cache.set(cacheKey(origin, destination), {
      data: payload,
      expiresAt: now + LOWEST_FARE_TTL_MS,
    });

    return {
      statusCode: 200,
      payload,
      headers: { 'Cache-Control': 'private, max-age=60' },
    };
  } catch (error) {
    return {
      statusCode: 502,
      payload: {
        error: 'UPSTREAM_ERROR',
        detail: error && error.message ? error.message : String(error),
      },
    };
  }
}

function clearLowestFareCache() {
  cache.clear();
}

module.exports = {
  handleLowestFareRequest,
  clearLowestFareCache,
  normalizeLowestFarePayload,
};
