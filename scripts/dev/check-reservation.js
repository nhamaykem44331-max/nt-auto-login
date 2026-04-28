#!/usr/bin/env node
/**
 * check-reservation.js
 * Mở trang reservation-status của booking.namthanh.vn với session hiện tại,
 * dump nội dung text + intercept API response để xác định số tiền thực tế
 * của các PNR.
 *
 * Usage: node scripts/dev/check-reservation.js [PNR1 PNR2 ...]
 */

const { chromium } = require('playwright');
const path = require('path');
const config = require('../../src/config');

const RESERVATION_URL = 'https://booking.namthanh.vn/booking/reservation-status';
const WATCH_SECONDS = 20;

async function main() {
  const targetPnrs = process.argv.slice(2).map((s) => s.toUpperCase());

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    storageState: config.paths.sessionFile,
    viewport: { width: 1440, height: 900 },
    userAgent: config.browser.userAgent,
  });

  const page = await context.newPage();

  const apiResponses = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (!/muadi|namthanh/i.test(url)) return;
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    try {
      const body = await res.json();
      apiResponses.push({ url, status: res.status(), body });
    } catch (_) {}
  });

  page.on('request', (req) => {
    const url = req.url();
    if (/muadi|namthanh/i.test(url)) {
      const short = url.replace(/^https?:\/\/[^/]+\//, '/');
      console.log(`  [REQ] ${req.method()} ${short.slice(0, 140)}`);
    }
  });
  page.on('response', (res) => {
    const url = res.url();
    if (/muadi|namthanh/i.test(url)) {
      const short = url.replace(/^https?:\/\/[^/]+\//, '/');
      console.log(`  [RES ${res.status()}] ${short.slice(0, 140)}`);
    }
  });

  // Bước 1: nạp trang root để seed localStorage vào SPA
  console.log('Seeding localStorage via homepage...');
  await page.goto('https://booking.namthanh.vn/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  const homeUrl = page.url();
  console.log(`After home: ${homeUrl}`);

  if (/\/login/i.test(homeUrl)) {
    console.log('ERROR: Bị redirect về login ngay từ home — có thể access token đã hết hạn.');
    const lsDump = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).map(([k,v])=>[k, v.length > 120 ? v.slice(0,120)+'…' : v])));
    console.log('localStorage hiện có:', JSON.stringify(lsDump, null, 2));
    await browser.close();
    process.exit(2);
  }

  console.log(`Navigating to ${RESERVATION_URL}...`);
  await page.goto(RESERVATION_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const url1 = page.url();
  console.log(`Current URL: ${url1}`);

  if (/login/i.test(url1)) {
    console.log('ERROR: Redirected to login — session dead.');
    await browser.close();
    process.exit(2);
  }

  // Chờ data load xong (bảng reservation)
  try {
    await page.waitForSelector('table, .table, tr', { timeout: 10000 });
  } catch (_) { /* ignore */ }
  await page.waitForTimeout(2000);

  const text = await page.evaluate(() => document.body.innerText);
  console.log('\n===== PAGE TEXT (first 5000 chars) =====');
  console.log(text.slice(0, 5000));

  if (targetPnrs.length) {
    console.log('\n===== SEARCH SPECIFIC PNRs =====');
    for (const pnr of targetPnrs) {
      const idx = text.indexOf(pnr);
      if (idx === -1) {
        console.log(`  ${pnr}: NOT FOUND on first page (may need pagination/filter)`);
        continue;
      }
      // In ra context ±300 chars quanh PNR
      const start = Math.max(0, idx - 200);
      const end = Math.min(text.length, idx + 400);
      console.log(`\n  >>> ${pnr} context:`);
      console.log(text.slice(start, end).replace(/\n+/g, ' | '));
    }
  }

  console.log('\n===== API RESPONSES (JSON only) =====');
  for (const r of apiResponses) {
    console.log(`\n[${r.status}] ${r.url}`);
    const summary = JSON.stringify(r.body).slice(0, 1500);
    console.log(summary);
  }

  // Try to dump table rows structured
  try {
    const rows = await page.$$eval('table tr', (trs) =>
      trs.map((tr) => Array.from(tr.querySelectorAll('td,th')).map((c) => c.innerText.trim()))
    );
    console.log('\n===== TABLE ROWS =====');
    rows.forEach((r, i) => {
      if (r.some((c) => c)) console.log(`[${i}] ${r.join(' | ')}`);
    });
  } catch (e) {
    console.log('Could not extract table rows:', e.message);
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
