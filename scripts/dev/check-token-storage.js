/**
 * check-token-storage.js
 *
 * Sau khi login thành công, kiểm tra token được lưu ở đâu:
 *   - localStorage
 *   - sessionStorage
 *   - cookies
 *
 * Mục đích: Hiểu cơ chế auth của muadi.com.vn để fix lỗi 401
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('../../src/config');
const { login } = require('../../src/login');

async function main() {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 300,
  });

  // Log TẤT CẢ network requests để xem auth pattern
  const authLogs = [];

  try {
    // Login
    const { page, context } = await login(browser);
    console.log(`\n✅ Login OK. URL: ${page.url()}\n`);

    // Setup monitoring TRƯỚC KHI điều hướng
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('muadi.com.vn') || url.includes('api')) {
        authLogs.push({
          type: 'REQUEST',
          method: req.method(),
          url: url,
          headers: req.headers(),
          postData: req.postData()?.slice(0, 500),
          timestamp: new Date().toISOString(),
        });
      }
    });

    page.on('response', async (res) => {
      const url = res.url();
      if (url.includes('muadi.com.vn') || url.includes('api')) {
        const log = {
          type: 'RESPONSE',
          status: res.status(),
          url: url,
          timestamp: new Date().toISOString(),
        };
        try {
          const ct = res.headers()['content-type'] || '';
          if (ct.includes('json')) {
            log.body = await res.json().catch(() => null);
          }
        } catch (e) {}
        authLogs.push(log);
      }
    });

    // Đợi dashboard ổn định
    await page.waitForTimeout(5000);

    // 1. Kiểm tra localStorage
    const localStorageData = await page.evaluate(() => {
      const data = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        const value = localStorage.getItem(key);
        data[key] = value?.slice(0, 500);
      }
      return data;
    });

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📦 LOCALSTORAGE:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(JSON.stringify(localStorageData, null, 2));

    // 2. Kiểm tra sessionStorage
    const sessionStorageData = await page.evaluate(() => {
      const data = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        const value = sessionStorage.getItem(key);
        data[key] = value?.slice(0, 500);
      }
      return data;
    });

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📦 SESSIONSTORAGE:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(JSON.stringify(sessionStorageData, null, 2));

    // 3. Kiểm tra cookies
    const cookies = await context.cookies();
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🍪 COOKIES:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(JSON.stringify(cookies.map(c => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      value: c.value.slice(0, 80) + (c.value.length > 80 ? '...' : ''),
      httpOnly: c.httpOnly,
      secure: c.secure,
    })), null, 2));

    // 4. Thử điền form HAN → SGN → ngày rồi submit để xem requests
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔬 THỬ SUBMIT ĐỂ XEM REQUESTS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Quick fill + submit
    const fromInput = await page.$('input[placeholder="Chọn điểm đi"]');
    await fromInput.click();
    await page.keyboard.type('HAN', { delay: 100 });
    await page.waitForTimeout(1200);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);

    const toInput = await page.$('input[placeholder="Chọn điểm đến"]');
    await toInput.click();
    await page.keyboard.type('SGN', { delay: 100 });
    await page.waitForTimeout(1200);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);

    // Chọn ngày 25 (ngay trong tháng hiện tại)
    await page.click('#departureTime');
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const days = document.querySelectorAll('.rdrDay:not(.rdrDayDisabled):not(.rdrDayPassive)');
      for (const el of days) {
        const d = el.querySelector('.day')?.innerText;
        if (parseInt(d) === 25) { el.click(); return; }
      }
    });
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.mouse.click(50, 50);
    await page.waitForTimeout(500);

    // CLEAR logs để chỉ capture request submit
    authLogs.length = 0;
    console.log('📊 Clear logs, bắt đầu submit...');

    const submitBtn = await page.$('button:has-text("Tìm chuyến bay")');
    await submitBtn.scrollIntoViewIfNeeded();
    await submitBtn.click({ force: true });

    console.log('⏱️  Đợi 10 giây để capture mọi request...');
    await page.waitForTimeout(10000);

    // Lưu tất cả
    const outputDir = config.paths.screenshotDir;
    fs.writeFileSync(
      path.join(outputDir, 'auth-localStorage.json'),
      JSON.stringify(localStorageData, null, 2)
    );
    fs.writeFileSync(
      path.join(outputDir, 'auth-sessionStorage.json'),
      JSON.stringify(sessionStorageData, null, 2)
    );
    fs.writeFileSync(
      path.join(outputDir, 'auth-cookies.json'),
      JSON.stringify(cookies, null, 2)
    );
    fs.writeFileSync(
      path.join(outputDir, 'auth-submit-network.json'),
      JSON.stringify(authLogs, null, 2)
    );

    console.log('\n✅ ĐÃ LƯU:');
    console.log(`   ${outputDir}/auth-localStorage.json`);
    console.log(`   ${outputDir}/auth-sessionStorage.json`);
    console.log(`   ${outputDir}/auth-cookies.json`);
    console.log(`   ${outputDir}/auth-submit-network.json`);
    console.log(`\n🔍 Network logs: ${authLogs.length} entries`);

    // Print summary
    console.log('\n📋 SUMMARY REQUESTS KHI SUBMIT:');
    authLogs.filter(l => l.type === 'REQUEST').forEach((log, i) => {
      console.log(`  ${i + 1}. ${log.method} ${log.url.slice(0, 100)}`);
      if (log.headers?.authorization) {
        console.log(`     Authorization: ${log.headers.authorization.slice(0, 50)}...`);
      }
    });
    console.log('\n📋 SUMMARY RESPONSES:');
    authLogs.filter(l => l.type === 'RESPONSE').forEach((log, i) => {
      console.log(`  ${i + 1}. ${log.status} ${log.url.slice(0, 100)}`);
      if (log.body?.message) {
        console.log(`     → ${log.body.message}`);
      }
    });

    console.log('\n⏸️  Nhấn Enter để đóng browser...');
    await new Promise((resolve) => process.stdin.once('data', resolve));
  } catch (error) {
    console.error('❌ Lỗi:', error.message);
  } finally {
    await browser.close();
    process.exit(0);
  }
}

main();
