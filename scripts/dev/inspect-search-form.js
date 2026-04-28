/**
 * inspect-search-form.js
 *
 * Script 2 bước:
 *   1. Tự động login vào booking.namthanh.vn (tái sử dụng code đã có)
 *   2. Vào trang đặt vé, dump toàn bộ cấu trúc form tra giá
 *      để biết selectors, cách tương tác autocomplete, date picker, dropdown...
 *
 * Chạy: node src/inspect-search-form.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('../../src/config');
const { login } = require('../../src/login');

const DEBUG_DIR = './debug';

async function inspect() {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  console.log('🔍 Inspect form tra giá của namthanh.vn\n');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 300,
  });

  try {
    // Bước 1: Login (tái sử dụng code đã có)
    console.log('━━━ PHASE 1: LOGIN ━━━');
    const { page, context } = await login(browser);

    // Đợi trang chuyển sang dashboard/booking
    await page.waitForTimeout(3000);
    console.log(`\n✅ Đã login. URL hiện tại: ${page.url()}`);

    // Bước 2: Chụp screenshot trang sau login
    await page.screenshot({
      path: path.join(DEBUG_DIR, '10-after-login-full.png'),
      fullPage: true,
    });
    console.log('✅ Screenshot: debug/10-after-login-full.png');

    // Bước 3: Lưu HTML
    const html = await page.content();
    fs.writeFileSync(path.join(DEBUG_DIR, '11-search-page.html'), html);
    console.log('✅ HTML: debug/11-search-page.html');

    // Bước 4: Dump tất cả inputs, buttons, selects, radio buttons
    console.log('\n━━━ PHASE 2: ANALYZE FORM ━━━');

    const formElements = await page.evaluate(() => {
      const elements = [];

      // Tất cả input, select, textarea, button
      const selectors = [
        'input', 'select', 'textarea', 'button',
        '[role="button"]', '[role="combobox"]', '[role="listbox"]',
        '[role="radio"]', '[role="checkbox"]',
        '.MuiSelect-root', '.MuiAutocomplete-root', // Material-UI
        '[class*="select" i]', '[class*="dropdown" i]',
      ];

      const seen = new Set();

      for (const selector of selectors) {
        try {
          const nodes = document.querySelectorAll(selector);
          nodes.forEach((el) => {
            if (seen.has(el)) return;
            seen.add(el);

            const rect = el.getBoundingClientRect();
            // Bỏ qua elements không visible
            if (rect.width === 0 || rect.height === 0) return;

            const parent = el.parentElement;
            const grandparent = parent?.parentElement;

            elements.push({
              tag: el.tagName,
              type: el.type || null,
              name: el.name || null,
              id: el.id || null,
              placeholder: el.placeholder || null,
              className: typeof el.className === 'string' ? el.className.slice(0, 100) : null,
              role: el.getAttribute('role'),
              ariaLabel: el.getAttribute('aria-label'),
              text: el.innerText?.slice(0, 80) || null,
              parentText: parent?.innerText?.slice(0, 120) || null,
              grandparentClass: grandparent?.className?.slice(0, 100) || null,
              position: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
            });
          });
        } catch (e) {}
      }

      return elements;
    });

    // Sắp xếp theo vị trí trên trang (trên xuống dưới, trái qua phải)
    formElements.sort((a, b) => {
      if (Math.abs(a.position.y - b.position.y) > 20) {
        return a.position.y - b.position.y;
      }
      return a.position.x - b.position.x;
    });

    fs.writeFileSync(
      path.join(DEBUG_DIR, '12-form-elements.json'),
      JSON.stringify(formElements, null, 2)
    );
    console.log(`✅ Tìm thấy ${formElements.length} form elements`);
    console.log('✅ Chi tiết: debug/12-form-elements.json');

    // Bước 5: Thử tương tác với autocomplete "Chọn điểm đi" để xem behavior
    console.log('\n━━━ PHASE 3: TEST AUTOCOMPLETE ━━━');

    try {
      // Tìm input "Chọn điểm đi" bằng placeholder
      const fromInput = await page.$('input[placeholder*="điểm đi" i]');
      if (fromInput) {
        console.log('  ✓ Tìm thấy input "Chọn điểm đi"');
        await fromInput.click();
        await page.waitForTimeout(500);
        await fromInput.fill('HAN');
        await page.waitForTimeout(1500); // đợi suggestions xuất hiện

        // Screenshot trạng thái có autocomplete
        await page.screenshot({
          path: path.join(DEBUG_DIR, '13-autocomplete-open.png'),
          fullPage: false,
        });
        console.log('  ✓ Screenshot autocomplete: debug/13-autocomplete-open.png');

        // Dump structure của dropdown suggestions
        const suggestions = await page.evaluate(() => {
          // Tìm các element có thể là suggestion list
          const candidates = document.querySelectorAll(
            '[role="listbox"] [role="option"], ' +
            '.MuiAutocomplete-option, ' +
            'ul li, ' +
            '[class*="option" i], ' +
            '[class*="suggestion" i], ' +
            '[class*="dropdown" i] > *'
          );
          return Array.from(candidates).slice(0, 20).map((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return null;
            return {
              tag: el.tagName,
              className: typeof el.className === 'string' ? el.className.slice(0, 100) : null,
              role: el.getAttribute('role'),
              text: el.innerText?.slice(0, 100),
              position: { x: Math.round(rect.x), y: Math.round(rect.y) },
            };
          }).filter(Boolean);
        });

        fs.writeFileSync(
          path.join(DEBUG_DIR, '14-autocomplete-suggestions.json'),
          JSON.stringify(suggestions, null, 2)
        );
        console.log(`  ✓ Tìm thấy ${suggestions.length} suggestion candidates`);
      } else {
        console.log('  ⚠️  Không tìm thấy input "Chọn điểm đi"');
      }
    } catch (e) {
      console.log('  ⚠️  Lỗi khi test autocomplete:', e.message);
    }

    // Bước 6: Inspect date picker
    console.log('\n━━━ PHASE 4: TEST DATE PICKER ━━━');
    try {
      const dateInput = await page.$('input[placeholder*="DD-MM-YYYY" i]');
      if (dateInput) {
        console.log('  ✓ Tìm thấy date picker');
        await dateInput.click();
        await page.waitForTimeout(1000);

        await page.screenshot({
          path: path.join(DEBUG_DIR, '15-datepicker-open.png'),
          fullPage: false,
        });
        console.log('  ✓ Screenshot: debug/15-datepicker-open.png');

        // Dump structure date picker
        const datePickerHtml = await page.evaluate(() => {
          const picker = document.querySelector(
            '.MuiPickersPopper-root, ' +
            '[class*="datepicker" i], ' +
            '[class*="calendar" i], ' +
            '[role="dialog"]'
          );
          return picker ? picker.outerHTML.slice(0, 3000) : null;
        });

        if (datePickerHtml) {
          fs.writeFileSync(
            path.join(DEBUG_DIR, '16-datepicker.html'),
            datePickerHtml
          );
          console.log('  ✓ HTML: debug/16-datepicker.html');
        }

        // Đóng date picker
        await page.keyboard.press('Escape');
      }
    } catch (e) {
      console.log('  ⚠️  Lỗi date picker:', e.message);
    }

    // Bước 7: Inspect dropdowns (GDS, hệ thống)
    console.log('\n━━━ PHASE 5: TEST DROPDOWNS ━━━');
    const dropdownLabels = ['hãng vận chuyển', 'hệ thống', 'hạng vé', 'chế độ hiển thị'];

    for (const labelText of dropdownLabels) {
      try {
        // Tìm dropdown bằng label text gần đó
        const clicked = await page.evaluate((label) => {
          const labels = Array.from(document.querySelectorAll('label, div, span'));
          const matchLabel = labels.find((el) =>
            el.innerText?.toLowerCase().includes(label.toLowerCase()) &&
            el.innerText.length < 100
          );
          if (!matchLabel) return null;

          // Tìm dropdown/select gần label này
          const parent = matchLabel.parentElement;
          const dropdown = parent?.querySelector('select, [role="combobox"], [role="button"], input, .MuiSelect-root');
          if (dropdown) {
            dropdown.click();
            return { found: true, tag: dropdown.tagName, className: dropdown.className?.toString().slice(0, 100) };
          }
          return null;
        }, labelText);

        if (clicked) {
          await page.waitForTimeout(800);
          const safeName = labelText.replace(/[^a-z0-9]/gi, '_');
          await page.screenshot({
            path: path.join(DEBUG_DIR, `17-dropdown-${safeName}.png`),
            fullPage: false,
          });
          console.log(`  ✓ Dropdown "${labelText}": ${JSON.stringify(clicked)}`);

          // Đóng dropdown
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
        }
      } catch (e) {
        console.log(`  ⚠️  Dropdown "${labelText}":`, e.message);
      }
    }

    // Kết thúc
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ HOÀN TẤT INSPECT');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('File cần gửi lại cho Claude:');
    console.log('  1. debug/10-after-login-full.png (screenshot trang đặt vé)');
    console.log('  2. debug/12-form-elements.json (danh sách form elements)');
    console.log('  3. debug/13-autocomplete-open.png (autocomplete khi gõ "HAN")');
    console.log('  4. debug/14-autocomplete-suggestions.json (cấu trúc suggestion)');
    console.log('  5. debug/15-datepicker-open.png (date picker)');
    console.log('  6. debug/16-datepicker.html (HTML date picker)');
    console.log('  7. Các file 17-dropdown-*.png (dropdowns)');
    console.log('\n⏸️  Browser đang mở. Nhấn Enter để đóng...');

    await new Promise((resolve) => process.stdin.once('data', resolve));
  } catch (error) {
    console.error('❌ Lỗi:', error.message);
  } finally {
    await browser.close();
    process.exit(0);
  }
}

inspect();
