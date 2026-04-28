#!/usr/bin/env node
/**
 * dump-airports.js
 *
 * Mở booking.namthanh.vn bằng storage-state hiện có, tương tác với ô điểm đi,
 * và capture các response API liên quan đến danh mục sân bay/autocomplete.
 *
 * Mục tiêu:
 *  1. Tìm endpoint thật Nam Thanh/Muadi đang dùng cho airports
 *  2. Lưu lại payload để phục vụ build airports.json
 *
 * Chạy:
 *   node scripts/dev/dump-airports.js
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('../../src/config');

const DEBUG_DIR = path.join(__dirname, '../../debug/airports-dump');
const WATCH_HOSTS = ['booking.namthanh.vn', 'api-gateway.muadi.com.vn'];
const QUERY_SAMPLES = ['a', 'b', 'han', 'bang', 'abu'];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function looksAirportPayload(value) {
  if (!value) return false;
  if (Array.isArray(value)) {
    return value.some((item) => {
      if (!item || typeof item !== 'object') return false;
      return (
        typeof item.code === 'string' ||
        typeof item.airportCode === 'string' ||
        typeof item.iata === 'string' ||
        typeof item.name === 'string' ||
        typeof item.city === 'string'
      );
    });
  }
  if (typeof value === 'object') {
    return Object.values(value).some((child) => looksAirportPayload(child));
  }
  return false;
}

async function pickAirportInput(page) {
  const selectors = [
    'input[placeholder*="điểm đi" i]',
    'input[placeholder*="diem di" i]',
    'input[placeholder*="from" i]',
    'input[aria-label*="điểm đi" i]',
    'input[aria-label*="from" i]',
  ];

  for (const selector of selectors) {
    const handle = await page.$(selector);
    if (handle) return handle;
  }

  const handles = await page.$$('input');
  for (const handle of handles) {
    const box = await handle.boundingBox();
    if (!box || box.width < 120 || box.height < 24) continue;
    const meta = await handle.evaluate((el) => ({
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
    }));
    const haystack = `${meta.placeholder} ${meta.ariaLabel}`.toLowerCase();
    if (haystack.includes('đi') || haystack.includes('from')) return handle;
  }

  return null;
}

async function main() {
  ensureDir(DEBUG_DIR);

  const browser = await chromium.launch({
    headless: false,
    slowMo: 150,
    args: ['--no-sandbox'],
  });

  const context = await browser.newContext({
    storageState: config.paths.sessionFile,
    viewport: { width: 1440, height: 900 },
    userAgent: config.browser.userAgent,
  });

  const page = await context.newPage();
  const captures = [];

  page.on('response', async (response) => {
    const url = response.url();
    if (!WATCH_HOSTS.some((host) => url.includes(host))) return;

    const contentType = response.headers()['content-type'] || '';
    const status = response.status();
    const entry = {
      ts: new Date().toISOString(),
      status,
      url,
      contentType,
    };

    try {
      if (contentType.includes('application/json')) {
        const json = await response.json();
        entry.kind = looksAirportPayload(json) ? 'airport-ish-json' : 'json';
        entry.preview = JSON.stringify(json).slice(0, 4000);
      } else {
        const text = await response.text();
        entry.kind = /airport|san bay|sân bay|diem di|điểm đi|origin|destination|autocomplete/i.test(text)
          ? 'airport-ish-text'
          : 'text';
        entry.preview = text.slice(0, 2000);
      }
    } catch (error) {
      entry.kind = 'unreadable';
      entry.error = error.message;
    }

    if (/airport|autocomplete|origin|destination|san-bay|san_bay|flight\/search/i.test(url) || String(entry.kind).startsWith('airport-ish')) {
      captures.push(entry);
      console.log(`[${status}] ${url}`);
    }
  });

  try {
    await page.goto('https://booking.namthanh.vn/', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.screenshot({ path: path.join(DEBUG_DIR, '01-home.png'), fullPage: true });

    const input = await pickAirportInput(page);
    if (!input) {
      throw new Error('Không tìm thấy ô điểm đi để test autocomplete.');
    }

    for (const sample of QUERY_SAMPLES) {
      await input.click({ clickCount: 3 });
      await page.keyboard.press('Control+A').catch(() => {});
      await input.fill(sample);
      await page.waitForTimeout(1500);
      await page.screenshot({
        path: path.join(DEBUG_DIR, `query-${sample.replace(/[^a-z0-9]/gi, '_')}.png`),
        fullPage: false,
      });
    }

    const allPath = path.join(DEBUG_DIR, 'captures.json');
    fs.writeFileSync(allPath, JSON.stringify(captures, null, 2));
    console.log(`\nSaved ${captures.length} captures to ${allPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
