/**
 * searchFlights.js
 *
 * Module tra giá vé máy bay trên booking.namthanh.vn
 *
 * Sử dụng:
 *   const { searchFlights } = require('./searchFlights');
 *   const results = await searchFlights(page, {
 *     from: 'HAN',
 *     to: 'SGN',
 *     departDate: '25-04-2026',
 *     returnDate: null,
 *     tripType: 'oneway',  // 'oneway' | 'roundtrip'
 *     passengers: { adult: 1, child: 0, infant: 0 },
 *     airline: null,        // null = all, 'VN', 'VJ', 'QH', 'BL'...
 *   });
 */

const fs = require('fs');
const path = require('path');
const { patchAuthHeaders } = require('./auth-patch');

/**
 * Parse date string "DD-MM-YYYY" → { day, month, year }
 */
function parseDate(dateStr) {
  const match = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(dateStr);
  if (!match) throw new Error(`Sai format ngày: ${dateStr}. Dùng DD-MM-YYYY`);
  return {
    day: parseInt(match[1], 10),
    month: parseInt(match[2], 10),
    year: parseInt(match[3], 10),
  };
}

/**
 * Chọn loại chuyến: Một chiều / Khứ hồi / Đa hành trình
 */
async function selectTripType(page, tripType) {
  const labels = {
    oneway: 'Một chiều',
    roundtrip: 'Khứ hồi',
    multi: 'Đa hành trình',
  };
  const labelText = labels[tripType] || labels.oneway;

  await page.click(`label:has-text("${labelText}"), span:has-text("${labelText}")`);
  console.log(`  ✓ Chọn loại: ${labelText}`);
  await page.waitForTimeout(300);
}

/**
 * Gõ vào autocomplete sân bay và chọn kết quả đầu tiên
 * Dùng ArrowDown + Enter vì không biết class của dropdown options
 */
async function fillAirportAutocomplete(page, placeholder, airportCode) {
  const selector = `input[placeholder="${placeholder}"]`;

  // Click vào input và clear nội dung cũ
  const input = await page.$(selector);
  if (!input) throw new Error(`Không tìm thấy input: ${placeholder}`);

  await input.click();
  await page.waitForTimeout(300);

  // Clear nội dung cũ (Ctrl+A + Delete)
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);

  // Gõ từng ký tự (một số autocomplete cần typing sự kiện từng phím)
  await page.keyboard.type(airportCode, { delay: 100 });

  // Đợi suggestions xuất hiện
  await page.waitForTimeout(1200);

  // Chọn kết quả đầu tiên: ArrowDown rồi Enter
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');

  console.log(`  ✓ Chọn sân bay: ${placeholder} = ${airportCode}`);
  await page.waitForTimeout(500);
}

/**
 * Chọn ngày trong date picker (react-date-range)
 * Điều hướng calendar đến đúng tháng/năm, click vào ngày
 */
async function selectDateInPicker(page, dateInputId, targetDate) {
  const { day, month, year } = parseDate(targetDate);

  // Click vào input để mở picker
  await page.click(`#${dateInputId}`);
  await page.waitForTimeout(800);

  // Đợi calendar hiển thị
  await page.waitForSelector('.rdrCalendarWrapper', { timeout: 5000 });

  // Điều hướng đến tháng/năm đúng
  // Đọc tháng hiện tại: text trong .rdrMonthAndYearPickers (vd: "Tháng Tư 2026")
  const vietnameseMonths = [
    'Tháng Một', 'Tháng Hai', 'Tháng Ba', 'Tháng Tư',
    'Tháng Năm', 'Tháng Sáu', 'Tháng Bảy', 'Tháng Tám',
    'Tháng Chín', 'Tháng Mười', 'Tháng Mười Một', 'Tháng Mười Hai'
  ];
  const targetMonthLabel = `${vietnameseMonths[month - 1]} ${year}`;

  let maxClicks = 36; // tối đa 3 năm forward/back
  let direction = null;

  while (maxClicks-- > 0) {
    const currentLabel = await page.evaluate(() => {
      const el = document.querySelector('.rdrMonthAndYearPickers');
      return el ? el.innerText.trim() : '';
    });

    if (currentLabel === targetMonthLabel) {
      console.log(`  ✓ Đã điều hướng đến: ${currentLabel}`);
      break;
    }

    // Xác định hướng: parse tháng/năm hiện tại và so sánh
    const currentMatch = /^(.+)\s+(\d{4})$/.exec(currentLabel);
    if (!currentMatch) throw new Error(`Không parse được calendar label: ${currentLabel}`);

    const currentMonthIdx = vietnameseMonths.indexOf(currentMatch[1].trim());
    const currentYear = parseInt(currentMatch[2], 10);
    const currentTotal = currentYear * 12 + currentMonthIdx;
    const targetTotal = year * 12 + (month - 1);

    if (targetTotal > currentTotal) {
      await page.click('.rdrNextButton');
      direction = 'next';
    } else {
      await page.click('.rdrPprevButton');
      direction = 'prev';
    }
    await page.waitForTimeout(250);
  }

  if (maxClicks <= 0) {
    throw new Error(`Không điều hướng được đến tháng ${targetMonthLabel}`);
  }

  // Click vào ngày cần chọn (phải là ngày không disabled, không phải passive)
  const clicked = await page.evaluate((targetDay) => {
    const days = document.querySelectorAll('.rdrDay:not(.rdrDayDisabled):not(.rdrDayPassive)');
    for (const d of days) {
      const dayEl = d.querySelector('.day, .rdrDayNumber span:first-child');
      if (dayEl && parseInt(dayEl.innerText, 10) === targetDay) {
        d.click();
        return true;
      }
    }
    return false;
  }, day);

  if (!clicked) {
    throw new Error(`Không click được ngày ${day} trong tháng ${targetMonthLabel}`);
  }

  console.log(`  ✓ Chọn ngày: ${targetDate}`);
  await page.waitForTimeout(500);

  // QUAN TRỌNG: Đóng date picker sau khi chọn (react-date-range không tự đóng)
  // Nếu không đóng, calendar sẽ che các element bên dưới → không click được "Tìm chuyến bay"
  await closeDatePicker(page);
}

/**
 * Đóng date picker nếu đang mở
 * react-date-range không tự đóng sau khi chọn ngày, phải đóng thủ công
 */
async function closeDatePicker(page) {
  // Cách 1: Nhấn Escape
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Kiểm tra calendar đã đóng chưa
  const stillOpen = await page.evaluate(() => {
    const calendar = document.querySelector('.rdrCalendarWrapper');
    if (!calendar) return false;
    const rect = calendar.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });

  if (stillOpen) {
    // Cách 2: Click vào tiêu đề "Đặt giữ chỗ" ở header (khu vực an toàn không có overlay)
    try {
      await page.click('h1, h2, h3, h4, h5, h6', { timeout: 2000 });
    } catch (e) {
      // Cách 3: Click vào vị trí an toàn (góc trên trái của viewport)
      await page.mouse.click(50, 50);
    }
    await page.waitForTimeout(300);
  }

  console.log(`  ✓ Đã đóng date picker`);
}

/**
 * Chọn option trong react-select dropdown
 */
async function selectReactSelectOption(page, inputId, optionText) {
  // Click vào input để mở dropdown
  await page.click(`#${inputId}`);
  await page.waitForTimeout(500);

  // Gõ text để filter
  await page.keyboard.type(optionText, { delay: 80 });
  await page.waitForTimeout(800);

  // Enter để chọn option đầu tiên
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);

  console.log(`  ✓ React-select #${inputId} = "${optionText}"`);
}

/**
 * Submit form và parse kết quả
 */
async function submitAndParseResults(page, screenshotDir) {
  console.log('\n🚀 Submit form tra giá...');

  // Đảm bảo không có overlay nào đang mở (date picker, dropdown...)
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Scroll nút submit vào viewport trước khi click
  const submitButton = await page.$('button:has-text("Tìm chuyến bay")');
  if (!submitButton) {
    throw new Error('Không tìm thấy nút "Tìm chuyến bay"');
  }

  await submitButton.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  // Thử click bình thường trước, nếu fail thì dùng force click
  try {
    await submitButton.click({ timeout: 5000 });
  } catch (e) {
    console.warn('  ⚠️  Click thường thất bại, thử force click...');
    await submitButton.click({ force: true });
  }

  console.log('  ✓ Đã click "Tìm chuyến bay"');

  // Đợi kết quả load (URL thường đổi hoặc loading indicator xuất hiện rồi biến mất)
  try {
    await page.waitForLoadState('networkidle', { timeout: 30000 });
  } catch (e) {
    console.warn('  ⚠️  Timeout đợi networkidle, tiếp tục parse...');
  }

  await page.waitForTimeout(2000);

  // Screenshot trang kết quả
  const resultsScreenshotPath = path.join(screenshotDir, `search-results-${Date.now()}.png`);
  await page.screenshot({ path: resultsScreenshotPath, fullPage: true });
  console.log(`  📸 Screenshot: ${resultsScreenshotPath}`);

  // Lưu HTML để Andy inspect cấu trúc kết quả
  const htmlPath = path.join(screenshotDir, `search-results-${Date.now()}.html`);
  fs.writeFileSync(htmlPath, await page.content());
  console.log(`  💾 HTML: ${htmlPath}`);

  // TODO: Parse kết quả sau khi biết cấu trúc HTML của danh sách chuyến bay
  // Hiện tại trả raw data để Andy gửi cho mình → mình sẽ build parser ở phase sau

  const rawResults = await page.evaluate(() => {
    // Thử tìm các patterns phổ biến của danh sách kết quả
    const patterns = [
      '[class*="flight" i]',
      '[class*="result" i]',
      'table tr',
      '[class*="ticket" i]',
      '.MuiTableRow-root',
    ];

    for (const pattern of patterns) {
      const elements = document.querySelectorAll(pattern);
      if (elements.length > 0 && elements.length < 100) {
        return {
          matchedSelector: pattern,
          count: elements.length,
          samples: Array.from(elements).slice(0, 3).map((el) => ({
            text: el.innerText?.slice(0, 200),
            className: typeof el.className === 'string' ? el.className : null,
          })),
        };
      }
    }
    return { message: 'Chưa detect được pattern kết quả' };
  });

  console.log('\n📊 Raw results info:');
  console.log(JSON.stringify(rawResults, null, 2));

  return { rawResults, screenshotPath: resultsScreenshotPath, htmlPath };
}

/**
 * Main function - tra giá vé
 */
async function searchFlights(page, params) {
  const {
    from,
    to,
    departDate,
    returnDate = null,
    tripType = 'oneway',
    passengers = { adult: 1, child: 0, infant: 0 },
    airline = null,
    screenshotDir = './screenshots',
  } = params;

  // Validate input
  if (!from || !to) throw new Error('Thiếu from/to');
  if (!departDate) throw new Error('Thiếu departDate');
  if (tripType === 'roundtrip' && !returnDate) {
    throw new Error('Khứ hồi cần returnDate');
  }

  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  console.log('\n╔════════════════════════════════════════╗');
  console.log('║  🔍 TRA GIÁ VÉ MÁY BAY                ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`  From: ${from}  →  To: ${to}`);
  console.log(`  Depart: ${departDate}${returnDate ? `  Return: ${returnDate}` : ''}`);
  console.log(`  Type: ${tripType}`);
  console.log(`  Passengers: ${JSON.stringify(passengers)}`);

  try {
    // 0. Patch: inject Authorization header vào mọi API request
    console.log('\n0️⃣  Setup auth patch:');
    await patchAuthHeaders(page);

    // 1. Chọn loại chuyến (Một chiều / Khứ hồi)
    console.log('\n1️⃣  Chọn loại chuyến:');
    await selectTripType(page, tripType);

    // 2. Điền sân bay đi
    console.log('\n2️⃣  Điểm đi:');
    await fillAirportAutocomplete(page, 'Chọn điểm đi', from);

    // 3. Điền sân bay đến
    console.log('\n3️⃣  Điểm đến:');
    await fillAirportAutocomplete(page, 'Chọn điểm đến', to);

    // 4. Chọn ngày đi
    console.log('\n4️⃣  Ngày đi:');
    await selectDateInPicker(page, 'departureTime', departDate);

    // 5. Chọn ngày về (nếu khứ hồi)
    if (tripType === 'roundtrip' && returnDate) {
      console.log('\n5️⃣  Ngày về:');
      await selectDateInPicker(page, 'arrivalTime', returnDate);
    }

    // 6. Chọn hãng vận chuyển (optional)
    if (airline) {
      console.log('\n6️⃣  Hãng vận chuyển:');
      await selectReactSelectOption(page, 'react-select-9-input', airline);
    }

    // 7. Submit và parse kết quả
    const results = await submitAndParseResults(page, screenshotDir);

    return {
      success: true,
      params: { from, to, departDate, returnDate, tripType, passengers },
      ...results,
    };
  } catch (error) {
    const errorScreenshot = path.join(screenshotDir, `search-error-${Date.now()}.png`);
    await page.screenshot({ path: errorScreenshot, fullPage: true }).catch(() => {});
    console.error('\n❌ Lỗi:', error.message);
    console.error('Screenshot:', errorScreenshot);
    throw error;
  }
}

module.exports = { searchFlights, parseDate };
