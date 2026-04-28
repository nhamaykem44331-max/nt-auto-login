/**
 * login.js
 *
 * Logic auto-login cho booking.namthanh.vn
 *
 * Đặc điểm của site:
 * - Captcha là HTML5 Canvas (#canv, 75x30px)
 * - Captcha đúng 3 ký tự (maxlength="3")
 * - Có nút reload captcha riêng (#reload_href)
 * - Form fields: #username, #password, #agentCode, #captcha
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const ddddocr = require('./ddddocr-client');
const logger = require('./logger');

/**
 * Export canvas thành PNG buffer.
 * Canvas không screenshot được như ảnh thường, phải dùng canvas.toDataURL().
 */
async function captureCanvasAsBuffer(page, canvasSelector) {
  // Đợi canvas render xong (có pixel data)
  await page.waitForFunction(
    (sel) => {
      const canvas = document.querySelector(sel);
      if (!canvas) return false;
      // Check canvas có nội dung không (không phải toàn trong suốt)
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      // Nếu có ít nhất 1 pixel không trong suốt → canvas đã render
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) return true;
      }
      return false;
    },
    canvasSelector,
    { timeout: 5000 }
  ).catch(() => {
    logger.warn('  ⚠️  Timeout chờ canvas render, thử đọc luôn...');
  });

  // Export canvas thành base64 PNG
  const dataUrl = await page.evaluate((sel) => {
    const canvas = document.querySelector(sel);
    if (!canvas) throw new Error(`Không tìm thấy canvas: ${sel}`);
    return canvas.toDataURL('image/png');
  }, canvasSelector);

  // Convert data URL → Buffer
  const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
  return Buffer.from(base64Data, 'base64');
}

/**
 * Reload captcha bằng cách click vào #reload_href
 */
async function reloadCaptcha(page) {
  try {
    const reloadEl = await page.$(config.selectors.captchaReload);
    if (reloadEl) {
      await reloadEl.click();
      await page.waitForTimeout(800);
      return true;
    }

    // Fallback: click vào canvas
    const canvasEl = await page.$(config.selectors.captchaCanvas);
    if (canvasEl) {
      await canvasEl.click();
      await page.waitForTimeout(800);
      return true;
    }
  } catch (e) {
    logger.warn('  ⚠️  Không reload được captcha:', e.message);
  }
  return false;
}

/**
 * Kiểm tra URL có phải vẫn là trang login không
 */
function isStillOnLoginPage(url) {
  return /\/login/.test(url);
}

/**
 * Thử đăng nhập 1 lần
 * Return: 'success' | 'captcha_wrong' | 'credentials_wrong' | 'unknown_error'
 */
async function attemptLogin(page, attemptNum) {
  logger.info(`\n🔄 Lần thử ${attemptNum}:`);

  // Chỉ điền username/password/agency 1 lần đầu
  if (attemptNum === 1) {
    await page.fill(config.selectors.usernameInput, '');
    await page.fill(config.selectors.usernameInput, config.credentials.username);
    logger.info(`  ✓ Username: ${config.credentials.username}`);

    await page.fill(config.selectors.passwordInput, '');
    await page.fill(config.selectors.passwordInput, config.credentials.password);
    logger.info(`  ✓ Password: ${'*'.repeat(config.credentials.password.length)}`);

    // Mã đại lý - có thể đã được điền sẵn (AML)
    const currentAgency = await page.inputValue(config.selectors.agencyCodeInput).catch(() => '');
    if (currentAgency !== config.credentials.agencyCode) {
      await page.fill(config.selectors.agencyCodeInput, '');
      await page.fill(config.selectors.agencyCodeInput, config.credentials.agencyCode);
    }
    logger.info(`  ✓ Mã đại lý: ${config.credentials.agencyCode}`);
  }

  // Đọc captcha từ canvas
  logger.info('  📸 Export canvas captcha → PNG buffer...');
  const captchaBuffer = await captureCanvasAsBuffer(page, config.selectors.captchaCanvas);

  // Lưu ảnh để debug
  const captchaPath = path.join(config.paths.screenshotDir, `captcha-attempt-${attemptNum}.png`);
  fs.writeFileSync(captchaPath, captchaBuffer);
  logger.info(`  💾 Lưu captcha: ${captchaPath} (${captchaBuffer.length} bytes)`);

  logger.info('  🤖 Gọi ddddocr...');
  const captchaText = await ddddocr.solveTextCaptcha(captchaBuffer, {
    charsetRange: config.captcha.charsetRange,
  });
  logger.info(`  🔤 OCR result: "${captchaText}" (length: ${captchaText.length})`);

  // Validate kết quả OCR
  if (!ddddocr.isValidCaptcha(captchaText, config.captcha.expectedLength)) {
    logger.info(`  ⚠️  OCR không hợp lệ (cần đúng 3 ký tự alphanumeric), reload...`);
    await reloadCaptcha(page);
    return 'captcha_wrong';
  }

  // Điền captcha
  await page.fill(config.selectors.captchaInput, '');
  await page.fill(config.selectors.captchaInput, captchaText);
  logger.info(`  ✓ Đã điền captcha: ${captchaText}`);

  // Submit
  const currentUrl = page.url();
  await page.click(config.selectors.submitButton);
  logger.info('  🚀 Click "Đăng nhập", chờ kết quả...');

  // Đợi navigation hoặc error message xuất hiện
  try {
    await page.waitForFunction(
      (oldUrl) => {
        if (window.location.href !== oldUrl) return true;
        // Check có error message xuất hiện không
        const text = document.body.innerText;
        return /sai|lỗi|không đúng|incorrect|invalid|error|thất bại/i.test(text);
      },
      currentUrl,
      { timeout: 8000 }
    );
  } catch (e) {
    // Timeout - vẫn tiếp tục check
  }

  // Lưới an toàn nhỏ để DOM settle sau redirect (giảm từ 1500ms).
  await page.waitForTimeout(300);

  const newUrl = page.url();
  const bodyText = await page.evaluate(() => document.body.innerText);

  // ✅ THÀNH CÔNG: URL không còn là /login nữa
  if (!isStillOnLoginPage(newUrl)) {
    logger.info(`  ✅ Đăng nhập thành công! URL mới: ${newUrl}`);
    return 'success';
  }

  // Check error messages cụ thể
  const captchaErrorPattern = /mã xác.*(sai|không đúng|invalid)|(sai|không đúng|invalid).*mã xác|captcha.*(sai|không đúng|invalid)/i;
  const credentialsErrorPattern = /(tài khoản|mật khẩu|username|password).*(sai|không đúng|incorrect|invalid)|đăng nhập.*(thất bại|sai)/i;

  if (captchaErrorPattern.test(bodyText)) {
    logger.info('  ❌ Captcha sai, reload và thử lại');
    await reloadCaptcha(page);
    return 'captcha_wrong';
  }

  if (credentialsErrorPattern.test(bodyText)) {
    logger.info('  ❌ Sai username/password/mã đại lý');
    return 'credentials_wrong';
  }

  // Nếu vẫn ở trang login mà không có error rõ ràng → giả định captcha sai
  if (isStillOnLoginPage(newUrl)) {
    logger.info('  ⚠️  Vẫn ở trang login, giả định captcha sai');
    await reloadCaptcha(page);
    return 'captcha_wrong';
  }

  logger.info(`  ❓ Không xác định được kết quả. URL: ${newUrl}`);
  return 'unknown_error';
}

const SKIP_HAPPY_SCREENSHOTS = String(process.env.LOGIN_SKIP_SCREENSHOTS || 'true').toLowerCase() === 'true';
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media']);
const BLOCKED_URL_RX = /google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|clarity|mixpanel|sentry\.io|segment\.io/i;

async function attachLoginRouteFilter(context) {
  try {
    await context.route('**/*', (route) => {
      const req = route.request();
      const type = req.resourceType();
      if (BLOCKED_RESOURCE_TYPES.has(type)) return route.abort();
      if (BLOCKED_URL_RX.test(req.url())) return route.abort();
      return route.continue();
    });
  } catch (err) {
    logger.warn('  ⚠️  Không gắn được route filter:', err.message);
  }
}

async function login(browser) {
  if (!fs.existsSync(config.paths.screenshotDir)) {
    fs.mkdirSync(config.paths.screenshotDir, { recursive: true });
  }
  const sessionDir = path.dirname(config.paths.sessionFile);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const context = await browser.newContext({
    viewport: config.browser.viewport,
    userAgent: config.browser.userAgent,
  });

  await attachLoginRouteFilter(context);
  const page = await context.newPage();

  try {
    logger.info('🏥 Kiểm tra ddddocr API...');
    const ocrHealthy = await ddddocr.healthCheck();
    if (!ocrHealthy) {
      throw new Error(
        `ddddocr API không phản hồi hoặc không phải OCR custom server tại ${config.ddddocr.apiUrl}.\n` +
        `Hãy chạy OCR custom của repo: npm run ocr`
      );
    }
    logger.info('  ✓ ddddocr API OK');

    logger.info(`\n📍 Mở ${config.loginUrl}`);
    // domcontentloaded là đủ vì captcha render từ JS — networkidle hay block 5-10s không cần thiết.
    await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Chờ form login render (không cần sleep cứng — captureCanvasAsBuffer đã có waitForFunction cho canvas).
    await page.waitForSelector(config.selectors.usernameInput, { timeout: 15000 });

    if (!SKIP_HAPPY_SCREENSHOTS) {
      await page.screenshot({
        path: path.join(config.paths.screenshotDir, 'before-login.png'),
        fullPage: true,
      }).catch(() => {});
    }

    let result;
    const attemptResults = [];

    for (let i = 1; i <= config.captcha.maxRetry; i++) {
      result = await attemptLogin(page, i);
      attemptResults.push(result);

      if (result === 'success') {
        await context.storageState({ path: config.paths.sessionFile });
        logger.info(`\n💾 Session đã lưu: ${config.paths.sessionFile}`);

        if (!SKIP_HAPPY_SCREENSHOTS) {
          await page.screenshot({
            path: path.join(config.paths.screenshotDir, 'after-login.png'),
            fullPage: true,
          }).catch(() => {});
        }

        // Thống kê
        const successRate = ((1 / i) * 100).toFixed(1);
        logger.info(`📊 Tỉ lệ thành công: ${i}/${i} lần thử = ${successRate}% accuracy OCR`);

        return { success: true, page, context };
      }

      if (result === 'credentials_wrong') {
        throw new Error('Sai username/password/mã đại lý. Kiểm tra .env');
      }

      if (result === 'captcha_wrong') {
        logger.info(`  ↻ Thử lại (${i}/${config.captcha.maxRetry})...`);
        await page.waitForTimeout(800);
        continue;
      }

      // unknown_error
      await page.screenshot({
        path: path.join(config.paths.screenshotDir, `error-attempt-${i}.png`),
        fullPage: true,
      });
      throw new Error(`Lỗi không xác định ở lần thử ${i}`);
    }

    // Thống kê lỗi
    logger.info('\n📊 Thống kê:');
    logger.info(`  Captcha wrong: ${attemptResults.filter((r) => r === 'captcha_wrong').length}`);

    throw new Error(
      `Đã thử ${config.captcha.maxRetry} lần mà captcha vẫn sai.\n` +
      `Có thể cần cải thiện accuracy OCR hoặc kiểm tra screenshots trong ${config.paths.screenshotDir}`
    );
  } catch (error) {
    await page.screenshot({
      path: path.join(config.paths.screenshotDir, 'error-final.png'),
      fullPage: true,
    }).catch(() => {});
    throw error;
  }
}

module.exports = { login };
