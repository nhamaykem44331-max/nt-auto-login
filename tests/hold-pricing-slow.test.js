'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BACKEND_ALLOW_NO_AUTH = 'true';

const logger = require('../src/logger');
const {
  enrichHoldResultWithPricing,
  normalizeHoldSummary,
} = require('../src/server');

function slowResolve(value, delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), delayMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

test('falls back to management/list-booking when ticket-info-by-id is too slow', async () => {
  const originalInfo = logger.info;
  const originalWarn = logger.warn;
  const originalError = logger.error;
  const logs = [];

  logger.info = (...args) => logs.push({ level: 'info', args });
  logger.warn = (...args) => logs.push({ level: 'warn', args });
  logger.error = (...args) => logs.push({ level: 'error', args });

  let ticketInfoCalls = 0;
  let fallbackCalls = 0;

  const sessionID = 280718080;
  const pnr = 'MY7DEX';
  const slowTicketInfoResponse = {
    data: {
      total: 2548200,
      currency: 'VND',
      listPNR: [
        {
          pnr,
          status: 'SUCCESS',
          timelimit: '21-04-2026 21:18:00',
          dep: 'SGN',
          ret: 'HAN',
        },
      ],
    },
  };

  const client = {
    getTicketInfoBySessionId() {
      ticketInfoCalls += 1;
      return slowResolve(slowTicketInfoResponse, 8000);
    },
    post(path) {
      fallbackCalls += 1;
      assert.equal(path, 'management/list-booking');
      return Promise.resolve({
        data: [
          {
            id: 123,
            pnrCode: pnr,
            totalPrice: 2548200,
            bookingStatus: 'SUCCESS',
            bookingStatusNote: 'SUCCESS',
            timelimit: '21-04-2026 21:18:00',
            bookingTime: '21-04-2026 10:00:00',
          },
        ],
      });
    },
    tryRefreshToken() {
      return Promise.resolve(false);
    },
  };

  const result = {
    dryRun: false,
    request: { sessionID },
    passenger: {
      title: 'MR',
      lastName: 'VU',
      firstName: 'QUANG MINH',
    },
    summary: {
      total: 2548200,
      currencyCode: 'VND',
    },
    ticketInfo: {
      data: {
        listPNR: [
          {
            pnr,
            status: 'WAIT',
            timelimit: '21-04-2026 21:18:00',
            dep: 'SGN',
            ret: 'HAN',
          },
        ],
      },
    },
    bookingResponse: {
      data: {
        listPNR: [
          {
            pnr,
            status: 'WAIT',
            timelimit: '21-04-2026 21:18:00',
            dep: 'SGN',
            ret: 'HAN',
          },
        ],
      },
    },
  };

  try {
    const enriched = await enrichHoldResultWithPricing(result, {}, {
      client,
      holdId: 'hold-test-slow',
      ticketInfoMaxAttempts: 3,
      ticketInfoInitialDelayMs: 1,
      ticketInfoRequestTimeoutMs: 25,
      fallbackMaxAttempts: 1,
      fallbackInitialDelayMs: 0,
    });
    const normalized = normalizeHoldSummary(enriched, 'hold-test-slow');

    assert.equal(ticketInfoCalls, 3);
    assert.equal(fallbackCalls, 1);
    assert.equal(enriched.pricing.verified, true);
    assert.equal(enriched.pricing.source, 'management/list-booking-fallback');
    assert.equal(typeof enriched.pricing.totalAmount, 'number');
    assert.equal(typeof normalized.totalAmount, 'number');
    assert.equal(normalized.totalAmount, 2548200);
    assert.ok(
      logs.some((entry) => entry.level === 'warn' && String(entry.args[0]).includes('fallback to list-booking'))
    );
    assert.ok(
      logs.some((entry) => entry.level === 'error' && String(entry.args[0]).includes('give up'))
    );
  } finally {
    logger.info = originalInfo;
    logger.warn = originalWarn;
    logger.error = originalError;
  }
});
