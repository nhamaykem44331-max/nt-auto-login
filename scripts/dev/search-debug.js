/**
 * search-debug.js
 *
 * Script debug nâng cao:
 *   - Log TẤT CẢ network requests/responses
 *   - Check URL trước mỗi bước
 *   - Monitor console errors
 *   - Thêm nhiều wait time để tránh race condition
 *   - Chạy ở slowMo cao để quan sát trực tiếp
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('../../src/config');
const { login } = require('../../src/login');
const { parseDate } = require('./searchFlights');

async function main() {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 500,  // Chậm lại để quan sát
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const networkLogs = [];
  const consoleLogs = [];

  try {
    console.log('╔══════════════════════════════════════╗');
    console.log('║  🐛 DEBUG: LOGIN + TRA GIÁ            ║');
    console.log('╚══════════════════════════════════════╝\n');

    // Step 1: Login
    const { page, context } = await login(browser);
    console.log(`\n✅ Login OK. URL: ${page.url()}`);

    // Setup network monitoring
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('namthanh.vn') || url.includes('api')) {
        networkLogs.push({
          type: 'REQUEST',
          method: req.method(),
          url: url,
          headers: req.headers(),
          postData: req.postData(),
          timestamp: new Date().toISOString(),
        });
      }
    });

    page.on('response', async (res) => {
      const url = res.url();
      if (url.includes('namthanh.vn') || url.includes('api')) {
        const log = {
          type: 'RESPONSE',
          status: res.status(),
          url: url,
          timestamp: new Date().toISOString(),
        };
        try {
          const contentType = res.headers()['content-type'] || '';
          if (contentType.includes('json')) {
            log.body = await res.json().catch(() => null);
          } else if (contentType.includes('text') || contentType.includes('html')) {
            log.body = (await res.text().catch(() => '')).slice(0, 2000);
          }
        } catch (e) {}
        networkLogs.push(log);
      }
    });

    page.on('console', (msg) => {
      consoleLogs.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: new Date().toISOString(),
      });
    });

    page.on('pageerror', (err) => {
      consoleLogs.push({
        type: 'PAGEERROR',
        text: err.message,
        stack: err.stack,
        timestamp: new Date().toISOString(),
      });
    });

    // Đợi dashboard load ỔN ĐỊNH
    console.log('\n⏱️  Đợi 5 giây cho dashboard ổn định...');
    await page.waitForTimeout(5000);
    console.log(`   URL sau khi đợi: ${page.url()}`);

    // Kiểm tra có còn đang login không
    if (page.url().includes('/login')) {
      throw new Error('Đã bị đăng xuất ngay sau login. Có thể session không được giữ.');
    }

    // Screenshot trạng thái ổn định sau login
    await page.screenshot({
      path: path.join(config.paths.screenshotDir, 'debug-01-dashboard.png'),
      fullPage: true,
    });
    console.log('📸 Đã chụp dashboard: debug-01-dashboard.png');

    // ====================
    // STEP 1: Điền điểm đi
    // ====================
    console.log('\n━━━ STEP 1: Điền điểm đi = HAN ━━━');
    const fromInput = await page.$('input[placeholder="Chọn điểm đi"]');
    if (!fromInput) throw new Error('Không tìm thấy input điểm đi');

    await fromInput.click();
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.type('HAN', { delay: 150 });
    await page.waitForTimeout(1500);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    console.log(`   URL: ${page.url()}`);
    if (page.url().includes('/login')) throw new Error('⚠️  Đã về login sau khi điền điểm đi');

    // ====================
    // STEP 2: Điền điểm đến
    // ====================
    console.log('\n━━━ STEP 2: Điền điểm đến = SGN ━━━');
    const toInput = await page.$('input[placeholder="Chọn điểm đến"]');
    await toInput.click();
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.type('SGN', { delay: 150 });
    await page.waitForTimeout(1500);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    console.log(`   URL: ${page.url()}`);
    if (page.url().includes('/login')) throw new Error('⚠️  Đã về login sau khi điền điểm đến');

    // ====================
    // STEP 3: Chọn ngày đi
    // ====================
    console.log('\n━━━ STEP 3: Chọn ngày đi = 25-04-2026 ━━━');
    const { day, month, year } = parseDate('25-04-2026');

    await page.click('#departureTime');
    await page.waitForTimeout(1000);
    await page.waitForSelector('.rdrCalendarWrapper');

    // Navigate tới Tháng Tư 2026 (đã đúng vì hôm nay là 19-04-2026)
    const vnMonths = [
      'Tháng Một', 'Tháng Hai', 'Tháng Ba', 'Tháng Tư',
      'Tháng Năm', 'Tháng Sáu', 'Tháng Bảy', 'Tháng Tám',
      'Tháng Chín', 'Tháng Mười', 'Tháng Mười Một', 'Tháng Mười Hai'
    ];
    const targetLabel = `${vnMonths[month - 1]} ${year}`;

    // Loop navigate
    let attempts = 24;
    while (attempts-- > 0) {
      const cur = await page.evaluate(() =>
        document.querySelector('.rdrMonthAndYearPickers')?.innerText.trim() || ''
      );
      if (cur === targetLabel) break;

      const match = /^(.+)\s+(\d{4})$/.exec(cur);
      if (!match) break;
      const curIdx = vnMonths.indexOf(match[1].trim());
      const curYear = parseInt(match[2]);

      if (curYear * 12 + curIdx < year * 12 + (month - 1)) {
        await page.click('.rdrNextButton');
      } else {
        await page.click('.rdrPprevButton');
      }
      await page.waitForTimeout(300);
    }

    // Click ngày
    const clicked = await page.evaluate((d) => {
      const days = document.querySelectorAll('.rdrDay:not(.rdrDayDisabled):not(.rdrDayPassive)');
      for (const el of days) {
        const dayNum = el.querySelector('.day')?.innerText;
        if (parseInt(dayNum) === d) {
          el.click();
          return true;
        }
      }
      return false;
    }, day);

    if (!clicked) throw new Error(`Không click được ngày ${day}`);
    console.log(`   ✓ Đã click ngày ${day}`);
    await page.waitForTimeout(1000);

    // Đóng date picker
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.mouse.click(50, 50); // click góc trái để đảm bảo đóng
    await page.waitForTimeout(500);

    console.log(`   URL: ${page.url()}`);
    if (page.url().includes('/login')) throw new Error('⚠️  Đã về login sau khi chọn ngày');

    // ====================
    // STEP 4: Screenshot form trước khi submit
    // ====================
    console.log('\n━━━ STEP 4: Screenshot trước submit ━━━');
    await page.screenshot({
      path: path.join(config.paths.screenshotDir, 'debug-02-before-submit.png'),
      fullPage: true,
    });
    console.log('   📸 debug-02-before-submit.png');

    // Dump giá trị các input
    const formState = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).map((el) => ({
        placeholder: el.placeholder,
        value: el.value,
        id: el.id,
        name: el.name,
      }));
      return inputs;
    });
    console.log('\n   📋 Trạng thái form:');
    console.log('  ', JSON.stringify(formState, null, 2));

    // ====================
    // STEP 5: Clear network logs rồi submit
    // ====================
    console.log('\n━━━ STEP 5: Submit ━━━');
    networkLogs.length = 0; // clear logs

    const submitBtn = await page.$('button:has-text("Tìm chuyến bay")');
    await submitBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    // LẮNG NGHE navigation / URL change
    const urlBefore = page.url();
    console.log(`   URL trước submit: ${urlBefore}`);

    try {
      await submitBtn.click({ timeout: 5000 });
      console.log('   ✓ Click submit thành công');
    } catch (e) {
      console.log('   ⚠️  Force click...');
      await submitBtn.click({ force: true });
    }

    // Đợi và log mọi thứ xảy ra
    console.log('\n⏱️  Đợi 8 giây để theo dõi response...');
    await page.waitForTimeout(8000);

    const urlAfter = page.url();
    console.log(`   URL sau submit: ${urlAfter}`);

    // Screenshot trạng thái sau submit
    await page.screenshot({
      path: path.join(config.paths.screenshotDir, 'debug-03-after-submit.png'),
      fullPage: true,
    });
    console.log('   📸 debug-03-after-submit.png');

    // Lưu HTML sau submit
    const htmlPath = path.join(config.paths.screenshotDir, 'debug-04-after-submit.html');
    fs.writeFileSync(htmlPath, await page.content());
    console.log(`   💾 ${htmlPath}`);

  } catch (error) {
    console.error('\n❌ LỖI:', error.message);
  } finally {
    // Lưu toàn bộ network + console logs
    const debugDir = config.paths.screenshotDir;

    fs.writeFileSync(
      path.join(debugDir, 'debug-network.json'),
      JSON.stringify(networkLogs, null, 2)
    );
    console.log(`\n💾 Network logs: ${debugDir}/debug-network.json (${networkLogs.length} entries)`);

    fs.writeFileSync(
      path.join(debugDir, 'debug-console.json'),
      JSON.stringify(consoleLogs, null, 2)
    );
    console.log(`💾 Console logs: ${debugDir}/debug-console.json (${consoleLogs.length} entries)`);

    console.log('\n⏸️  Browser đang mở để Andy inspect. Nhấn Enter để đóng...');
    await new Promise((resolve) => process.stdin.once('data', resolve));
    await browser.close();
    process.exit(0);
  }
}

main();
