#!/usr/bin/env node
/**
 * probe-refresh.js
 * Thử tìm refresh-token endpoint của api-gateway.muadi.com.vn
 * Chạy: node src/probe-refresh.js
 */

const axios = require('axios');
const { readStorageState, encryptMuadi } = require('../../src/muadi-client');
const config = require('../../src/config');

const BASE_URL = 'https://api-gateway.muadi.com.vn/api';
const BOOKING_ORIGIN = 'https://booking.namthanh.vn';

const CANDIDATE_ENDPOINTS = [
  'auth/refresh-token',
  'auth/refresh',
  'auth/token/refresh',
  'auth/renew',
  'token/refresh',
  'user/refresh-token',
  'account/refresh-token',
  'booking/refresh-token',
  'booking/renew-token',
];

function makeHeaders(accessToken, version = '2') {
  const tsp = Math.floor(Date.now() / 1000);
  const headers = {
    authorization: accessToken,
    tsp: encryptMuadi(tsp.toString()),
    'Client-Type': 'Web',
    'X-Language': 'vi',
    Origin: BOOKING_ORIGIN,
    Referer: `${BOOKING_ORIGIN}/`,
    'Content-Type': 'application/json',
  };
  if (version) headers['X-Api-Version'] = String(version);
  return headers;
}

async function probe(url, body, accessToken, label, version = '2') {
  try {
    const res = await axios.post(url, body, {
      headers: makeHeaders(accessToken, version),
      timeout: 10000,
      validateStatus: () => true,
    });
    return { status: res.status, data: res.data, label };
  } catch (err) {
    return { status: 'ERR', data: err.message, label };
  }
}

async function main() {
  let session;
  try {
    session = readStorageState();
  } catch (e) {
    console.error('Cannot read session:', e.message);
    process.exit(1);
  }

  const { accessToken, refreshToken } = session;

  console.log('=== Muadi Refresh Endpoint Probe ===');
  console.log(`accessToken: ...${accessToken.slice(-20)}`);
  console.log(`refreshToken: ...${refreshToken.slice(-20)}`);
  console.log('');

  // Body variants to try for each endpoint
  const bodyVariants = [
    {
      label: 'encrypted {accessToken, refreshToken, channel}',
      body: { encrypted: encryptMuadi(JSON.stringify({ accessToken, refreshToken, channel: 'Web' })) },
      version: null,
    },
    // 1. Encrypted — refreshToken inside encrypted payload
    {
      label: 'encrypted {refreshToken}',
      body: { encrypted: encryptMuadi(JSON.stringify({ refreshToken })) },
    },
    {
      label: 'encrypted {token: refreshToken}',
      body: { encrypted: encryptMuadi(JSON.stringify({ token: refreshToken })) },
    },
    {
      label: 'encrypted {refresh_token}',
      body: { encrypted: encryptMuadi(JSON.stringify({ refresh_token: refreshToken })) },
    },
    // 2. Plain (some auth endpoints skip encryption)
    {
      label: 'plain {refreshToken}',
      body: { refreshToken },
    },
    {
      label: 'plain {token}',
      body: { token: refreshToken },
    },
  ];

  const results = [];

  for (const endpoint of CANDIDATE_ENDPOINTS) {
    const url = `${BASE_URL}/${endpoint}`;
    for (const variant of bodyVariants) {
      const result = await probe(
        url,
        variant.body,
        accessToken,
        `${endpoint} [${variant.label}]`,
        variant.version === undefined ? null : variant.version
      );
      // Classify the result
      const interesting = result.status !== 404 && result.status !== 405 && result.status !== 'ERR';
      const success = result.status >= 200 && result.status < 300 && result.data?.success !== false;

      if (interesting) {
        results.push({ ...result, success });
        const icon = success ? '✅' : result.status === 401 ? '🔑' : '⚠️';
        console.log(`${icon} [${result.status}] ${result.label}`);
        if (success) {
          console.log('   DATA:', JSON.stringify(result.data).slice(0, 200));
        } else if (result.data && result.data.message) {
          console.log('   MSG:', result.data.message);
        }
      } else {
        process.stdout.write('.');
      }
    }
  }

  console.log('\n');
  const successes = results.filter((r) => r.success);
  if (successes.length) {
    console.log('=== FOUND WORKING REFRESH ENDPOINT ===');
    successes.forEach((r) => {
      console.log(`  ${r.label}`);
      console.log('  Response:', JSON.stringify(r.data).slice(0, 300));
    });
  } else {
    console.log('=== No working refresh endpoint found ===');
    console.log('Interesting non-404 responses:');
    results.forEach((r) => {
      console.log(`  [${r.status}] ${r.label}`);
      if (r.data?.message) console.log(`    MSG: ${r.data.message}`);
    });
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
