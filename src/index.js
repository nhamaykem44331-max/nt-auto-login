/**
 * index.js
 *
 * Entry point. Chạy auto-login và giữ browser mở để Andy thấy kết quả.
 *
 * Usage:
 *   npm start              # chạy bình thường
 *   npm run debug          # chạy với browser hiện lên
 */

const { chromium } = require('playwright');
const config = require('./config');
const { login } = require('./login');

// Validate env vars
function validateEnv() {
  const required = ['NAMTHANH_USERNAME', 'NAMTHANH_PASSWORD', 'NAMTHANH_AGENCY_CODE'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error('❌ Thiếu biến môi trường:', missing.join(', '));
    console.error('Hãy copy .env.example thành .env và điền đầy đủ');
    process.exit(1);
  }
}

async function main() {
  validateEnv();

  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  Nam Thanh Auto-Login Script                   ║');
  console.log('║  Sử dụng: Playwright + ddddocr                 ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log();

  const browser = await chromium.launch({
    headless: config.browser.headless,
    slowMo: config.browser.slowMo,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const { success, page, context } = await login(browser);

    if (success) {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('🎉 ĐĂNG NHẬP THÀNH CÔNG!');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`📍 URL hiện tại: ${page.url()}`);
      console.log(`💾 Session đã lưu: ${config.paths.sessionFile}`);
      console.log();
      console.log('Lần sau Andy có thể load lại session này mà không cần login:');
      console.log(`  const context = await browser.newContext({`);
      console.log(`    storageState: '${config.paths.sessionFile}'`);
      console.log(`  });`);
      console.log();

      if (!config.browser.headless) {
        console.log('⏸️  Browser đang mở. Nhấn Ctrl+C để thoát.');
        // Giữ browser mở để Andy kiểm tra
        await new Promise(() => {}); // infinite wait
      }
    }
  } catch (error) {
    console.error('\n❌ LỖI:', error.message);
    console.error('\nKiểm tra screenshots trong:', config.paths.screenshotDir);
    process.exit(1);
  } finally {
    if (config.browser.headless) {
      await browser.close();
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Thoát...');
  process.exit(0);
});

main();
