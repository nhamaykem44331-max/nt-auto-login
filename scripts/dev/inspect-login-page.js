/**
 * inspect-login-page.js
 *
 * Mục đích: Chạy lần ĐẦU TIÊN để khám phá cấu trúc trang login.
 * Script này sẽ:
 * 1. Mở trang login ở chế độ có giao diện (headless=false)
 * 2. Chụp screenshot toàn trang
 * 3. Lưu HTML của trang
 * 4. Tìm tất cả input fields và lưu selectors
 * 5. Tìm ảnh captcha và lưu riêng
 * 6. Dừng lại cho Andy inspect thủ công
 *
 * Chạy: npm run inspect
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DEBUG_DIR = './debug';

async function inspect() {
  // Tạo thư mục debug nếu chưa có
  if (!fs.existsSync(DEBUG_DIR)) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
  }

  console.log('🚀 Đang mở trình duyệt...');
  const browser = await chromium.launch({
    headless: false,  // Mở giao diện để Andy xem
    slowMo: 500,       // Chạy chậm lại 500ms/action để dễ quan sát
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Log tất cả network requests để xem captcha được load như thế nào
  const networkLogs = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('captcha') || url.includes('.png') || url.includes('.jpg') || url.includes('api')) {
      networkLogs.push({
        method: request.method(),
        url: url,
        resourceType: request.resourceType(),
      });
    }
  });

  try {
    console.log('📍 Điều hướng đến https://booking.namthanh.vn/login ...');
    await page.goto('https://booking.namthanh.vn/login', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Đợi thêm 2s cho SPA render xong
    await page.waitForTimeout(2000);

    // 1. Chụp screenshot toàn trang
    const screenshotPath = path.join(DEBUG_DIR, '01-full-page.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`✅ Đã lưu screenshot: ${screenshotPath}`);

    // 2. Lưu HTML
    const html = await page.content();
    fs.writeFileSync(path.join(DEBUG_DIR, '02-page-source.html'), html);
    console.log('✅ Đã lưu HTML: debug/02-page-source.html');

    // 3. Tìm tất cả input fields
    const inputs = await page.evaluate(() => {
      const all = document.querySelectorAll('input, select, textarea');
      return Array.from(all).map((el) => ({
        tag: el.tagName,
        type: el.type || null,
        name: el.name || null,
        id: el.id || null,
        placeholder: el.placeholder || null,
        className: el.className || null,
        ariaLabel: el.getAttribute('aria-label'),
        parentText: el.parentElement?.innerText?.slice(0, 100) || null,
      }));
    });

    fs.writeFileSync(
      path.join(DEBUG_DIR, '03-form-inputs.json'),
      JSON.stringify(inputs, null, 2)
    );
    console.log(`✅ Tìm thấy ${inputs.length} form elements, lưu vào debug/03-form-inputs.json`);

    // 4. Tìm tất cả ảnh (tìm captcha)
    const images = await page.evaluate(() => {
      const imgs = document.querySelectorAll('img');
      return Array.from(imgs).map((img) => ({
        src: img.src,
        alt: img.alt,
        width: img.naturalWidth,
        height: img.naturalHeight,
        className: img.className,
        id: img.id,
      }));
    });

    fs.writeFileSync(
      path.join(DEBUG_DIR, '04-images.json'),
      JSON.stringify(images, null, 2)
    );
    console.log(`✅ Tìm thấy ${images.length} ảnh, lưu vào debug/04-images.json`);

    // 5. Lưu network logs
    fs.writeFileSync(
      path.join(DEBUG_DIR, '05-network-logs.json'),
      JSON.stringify(networkLogs, null, 2)
    );
    console.log(`✅ Lưu network logs: debug/05-network-logs.json`);

    // 6. Cố gắng tìm và screenshot captcha riêng
    //    Heuristic: ảnh nhỏ, có từ "captcha" trong class/id/src
    const captchaSelectors = [
      'img[src*="captcha" i]',
      'img[class*="captcha" i]',
      'img[id*="captcha" i]',
      'img[alt*="captcha" i]',
      'canvas',  // đôi khi captcha render bằng canvas
    ];

    for (const selector of captchaSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          const captchaPath = path.join(DEBUG_DIR, `06-captcha-${selector.replace(/[^a-z0-9]/gi, '_')}.png`);
          await element.screenshot({ path: captchaPath });
          console.log(`🎯 Tìm thấy captcha với selector "${selector}": ${captchaPath}`);
        }
      } catch (e) {
        // ignore, thử selector tiếp theo
      }
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('⏸️  TRÌNH DUYỆT ĐANG MỞ');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Hãy kiểm tra thủ công:');
    console.log('  1. Mở DevTools (F12) → Inspect các input field');
    console.log('  2. Chuột phải vào ảnh captcha → Copy selector');
    console.log('  3. Note lại các selectors sau:');
    console.log('     - Username input');
    console.log('     - Password input');
    console.log('     - Mã đại lý input');
    console.log('     - Captcha image');
    console.log('     - Captcha input');
    console.log('     - Submit button');
    console.log('\n  Sau đó điền vào file src/config.js');
    console.log('\n⏎  Nhấn Enter trong terminal này để đóng trình duyệt...');

    // Đợi user nhấn Enter
    await new Promise((resolve) => {
      process.stdin.once('data', resolve);
    });
  } catch (error) {
    console.error('❌ Lỗi:', error.message);
    // Vẫn chụp screenshot khi lỗi để debug
    await page.screenshot({ path: path.join(DEBUG_DIR, 'error-state.png'), fullPage: true });
  } finally {
    await browser.close();
    console.log('\n✅ Hoàn tất inspect. Xem kết quả trong thư mục ./debug/');
    process.exit(0);
  }
}

inspect();
