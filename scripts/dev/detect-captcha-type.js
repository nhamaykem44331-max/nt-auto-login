/**
 * detect-captcha-type.js
 *
 * Xác định captcha của namthanh.vn là loại nào:
 * - Text HTML thuần → đọc bằng DOM, không cần OCR
 * - SVG → đọc text node
 * - Canvas → phải OCR
 * - Image CSS background → phải screenshot và OCR
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DEBUG_DIR = './debug';

async function detect() {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  console.log('🔍 Phát hiện loại captcha của namthanh.vn...\n');

  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const page = await browser.newPage();

  try {
    await page.goto('https://booking.namthanh.vn/login', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    // Tìm phần tử bên cạnh input#captcha (thường chứa captcha text/image)
    // Dựa trên screenshot, captcha hiển thị là "Y 3 N" ở bên phải input

    const analysis = await page.evaluate(() => {
      const captchaInput = document.getElementById('captcha');
      if (!captchaInput) return { error: 'Không tìm thấy input#captcha' };

      // Tìm tất cả phần tử gần input captcha (anh chị em, cha, chú bác)
      const findCaptchaDisplay = () => {
        const candidates = [];

        // 1. Anh chị em của input
        const parent = captchaInput.parentElement;
        if (parent) {
          Array.from(parent.children).forEach((el) => {
            if (el !== captchaInput) {
              candidates.push({ relation: 'sibling', element: el });
            }
          });

          // 2. Anh chị em của parent (cô/chú/bác)
          const grandparent = parent.parentElement;
          if (grandparent) {
            Array.from(grandparent.children).forEach((el) => {
              if (el !== parent) {
                candidates.push({ relation: 'uncle', element: el });
              }
            });
          }
        }

        return candidates;
      };

      const candidates = findCaptchaDisplay();

      return {
        error: null,
        captchaInput: {
          tag: captchaInput.tagName,
          id: captchaInput.id,
          outerHTML: captchaInput.outerHTML.slice(0, 200),
        },
        candidates: candidates.map(({ relation, element }) => ({
          relation,
          tag: element.tagName,
          id: element.id,
          className: element.className,
          innerText: element.innerText?.slice(0, 100),
          innerHTML: element.innerHTML?.slice(0, 500),
          hasCanvas: element.querySelector('canvas') !== null,
          hasSvg: element.querySelector('svg') !== null,
          hasImg: element.querySelector('img') !== null,
          backgroundImage: window.getComputedStyle(element).backgroundImage,
          childrenCount: element.children.length,
          childTags: Array.from(element.children).map((c) => c.tagName).join(','),
        })),
      };
    });

    console.log('📊 KẾT QUẢ PHÂN TÍCH:\n');
    console.log(JSON.stringify(analysis, null, 2));

    fs.writeFileSync(
      path.join(DEBUG_DIR, '07-captcha-analysis.json'),
      JSON.stringify(analysis, null, 2)
    );

    // Chụp vùng xung quanh captcha
    const captchaArea = await page.$('#captcha');
    if (captchaArea) {
      // Lấy bounding box và mở rộng sang phải để chụp cả vùng hiển thị captcha
      const box = await captchaArea.boundingBox();
      if (box) {
        await page.screenshot({
          path: path.join(DEBUG_DIR, '08-captcha-area.png'),
          clip: {
            x: Math.max(0, box.x - 50),
            y: Math.max(0, box.y - 20),
            width: Math.min(800, box.width + 500),
            height: box.height + 40,
          },
        });
        console.log('\n✅ Đã chụp vùng captcha: debug/08-captcha-area.png');
      }
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('⏸️  Browser đang mở. Nhấn Enter để đóng...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    await new Promise((resolve) => process.stdin.once('data', resolve));
  } catch (error) {
    console.error('❌ Lỗi:', error.message);
  } finally {
    await browser.close();
    process.exit(0);
  }
}

detect();
