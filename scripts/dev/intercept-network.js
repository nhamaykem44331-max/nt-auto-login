#!/usr/bin/env node
/**
 * intercept-network.js
 * Mở browser với session hiện tại, intercept tất cả request đến api-gateway.muadi.com.vn
 * Đặc biệt tìm các call liên quan đến refresh/renew token.
 *
 * Chạy: node src/intercept-network.js
 * Để browser mở ~60 giây, quan sát output.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('../../src/config');
const { readStorageState } = require('../../src/muadi-client');

const INTERCEPT_HOST = 'api-gateway.muadi.com.vn';
const WATCH_SECONDS = 90;

async function main() {
  let session;
  try {
    session = readStorageState();
  } catch (e) {
    console.error('Cannot read session:', e.message);
    process.exit(1);
  }

  console.log('=== Muadi Network Interceptor ===');
  console.log(`Watching all requests to ${INTERCEPT_HOST} for ${WATCH_SECONDS}s`);
  console.log('Navigating to booking site with current session...\n');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 0,
    args: ['--no-sandbox'],
  });

  const storageStatePath = config.paths.sessionFile;
  const context = await browser.newContext({
    storageState: storageStatePath,
    viewport: { width: 1366, height: 768 },
    userAgent: config.browser.userAgent,
  });

  const page = await context.newPage();
  const log = [];

  // Intercept all requests
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes(INTERCEPT_HOST)) return;
    const endpoint = url.replace(/^https?:\/\/[^/]+\/api\//, '');
    const method = req.method();
    let bodyPreview = '';
    try {
      const raw = req.postData();
      if (raw) bodyPreview = raw.slice(0, 200);
    } catch (_) {}

    const entry = { type: 'REQUEST', method, endpoint, body: bodyPreview, ts: new Date().toISOString() };
    log.push(entry);

    const isAuth = /refresh|renew|token|auth|login|session/i.test(endpoint);
    const icon = isAuth ? '🔑' : '→';
    console.log(`${icon} ${method} /${endpoint}`);
    if (bodyPreview) console.log(`   body: ${bodyPreview.slice(0, 120)}`);
  });

  // Intercept all responses
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes(INTERCEPT_HOST)) return;
    const endpoint = url.replace(/^https?:\/\/[^/]+\/api\//, '');
    const status = res.status();
    let bodyPreview = '';
    try {
      const text = await res.text();
      bodyPreview = text.slice(0, 300);
    } catch (_) {}

    const isAuth = /refresh|renew|token|auth|login|session/i.test(endpoint);
    const icon = status < 300 ? '✅' : status === 401 ? '🚫' : '⚠️';
    if (isAuth || status >= 400) {
      console.log(`${icon} [${status}] /${endpoint}`);
      if (bodyPreview) console.log(`   resp: ${bodyPreview.slice(0, 150)}`);
    }

    log.push({ type: 'RESPONSE', status, endpoint, body: bodyPreview, ts: new Date().toISOString() });
  });

  // Navigate to the booking page (will use saved session)
  try {
    await page.goto('https://booking.namthanh.vn/', { waitUntil: 'networkidle', timeout: 30000 });
    console.log(`\nPage loaded: ${page.url()}`);
    console.log('Waiting for token refresh calls...');
    console.log('TIP: Try navigating to different sections in the browser to trigger more API calls\n');
  } catch (e) {
    console.warn('Navigation warning:', e.message);
  }

  // Wait and let user interact
  await new Promise((resolve) => setTimeout(resolve, WATCH_SECONDS * 1000));

  // Save full log
  const logPath = path.join('.', 'debug', 'network-intercept.json');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));

  console.log(`\n=== Intercept complete. ${log.length} entries captured ===`);
  const authCalls = log.filter(
    (e) => e.type === 'REQUEST' && /refresh|renew|token|auth|login/i.test(e.endpoint)
  );
  if (authCalls.length) {
    console.log('\n=== Auth-related calls found ===');
    authCalls.forEach((e) => {
      console.log(`  ${e.method} /${e.endpoint}`);
      if (e.body) console.log(`    body: ${e.body.slice(0, 150)}`);
    });
  } else {
    console.log('\nNo refresh/auth calls observed during this session.');
    console.log('Token may still be valid — try again when token is close to expiry.');
  }

  console.log(`\nFull log saved: ${logPath}`);
  await browser.close();
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
