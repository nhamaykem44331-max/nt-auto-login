/**
 * search-test.js
 *
 * Script test end-to-end: login + tra giá vé
 *
 * Usage:
 *   node src/search-test.js
 *   node src/search-test.js HAN SGN 25-04-2026
 *   node src/search-test.js HAN SGN 25-04-2026 30-04-2026
 */

const { chromium } = require('playwright');
const config = require('../../src/config');
const { login } = require('../../src/login');
const { searchFlights } = require('./searchFlights');

// Parse command line args
const args = process.argv.slice(2);
const [
  from = 'HAN',
  to = 'SGN',
  departDate = '25-04-2026',
  returnDate = null,
] = args;

const tripType = returnDate ? 'roundtrip' : 'oneway';

function validateEnv() {
  const required = ['NAMTHANH_USERNAME', 'NAMTHANH_PASSWORD', 'NAMTHANH_AGENCY_CODE'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error('❌ Thiếu biến môi trường:', missing.join(', '));
    process.exit(1);
  }
}

async function main() {
  validateEnv();

  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  🎯 TEST END-TO-END: LOGIN + TRA GIÁ VÉ       ║');
  console.log('╚════════════════════════════════════════════════╝');

  const browser = await chromium.launch({
    headless: config.browser.headless,
    slowMo: config.browser.slowMo,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    // Step 1: Login
    const { success, page, context } = await login(browser);
    if (!success) throw new Error('Login thất bại');

    console.log('\n⏱️  Đợi trang dashboard load xong...');
    await page.waitForTimeout(3000);

    // Step 2: Tra giá
    const results = await searchFlights(page, {
      from,
      to,
      departDate,
      returnDate,
      tripType,
      passengers: { adult: 1, child: 0, infant: 0 },
      screenshotDir: config.paths.screenshotDir,
    });

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ HOÀN TẤT TRA GIÁ');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📸 Screenshot kết quả: ${results.screenshotPath}`);
    console.log(`📄 HTML kết quả: ${results.htmlPath}`);
    console.log('\n📊 Raw results info:');
    console.log(JSON.stringify(results.rawResults, null, 2));

    if (!config.browser.headless) {
      console.log('\n⏸️  Browser đang mở. Nhấn Ctrl+C để thoát.');
      await new Promise(() => {});
    }
  } catch (error) {
    console.error('\n❌ LỖI:', error.message);
    console.error('Kiểm tra screenshots trong:', config.paths.screenshotDir);
    process.exit(1);
  } finally {
    if (config.browser.headless) {
      await browser.close();
    }
  }
}

process.on('SIGINT', () => {
  console.log('\n👋 Thoát...');
  process.exit(0);
});

main();
