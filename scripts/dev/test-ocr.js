/**
 * test-ocr.js
 *
 * Test riêng ddddocr với ảnh có sẵn, không liên quan đến Playwright.
 * Dùng để:
 *  - Kiểm tra ddddocr API hoạt động không
 *  - Test accuracy với ảnh captcha đã lưu
 *
 * Usage:
 *   node src/test-ocr.js ./screenshots/captcha-attempt-1.png
 *   node src/test-ocr.js ./screenshots/captcha-attempt-1.png 5   # charsetRange=5
 */

const fs = require('fs');
const ddddocr = require('../../src/ddddocr-client');

async function main() {
  const imagePath = process.argv[2];
  const charsetRange = process.argv[3] ? parseInt(process.argv[3], 10) : 6;

  if (!imagePath) {
    console.error('Usage: node src/test-ocr.js <path-to-image> [charsetRange=6]');
    console.error('\nCharset range:');
    console.error('  0 = digits');
    console.error('  1 = lowercase');
    console.error('  2 = UPPERCASE');
    console.error('  3 = lower + UPPER');
    console.error('  4 = lower + digits');
    console.error('  5 = UPPER + digits');
    console.error('  6 = lower + UPPER + digits (default)');
    process.exit(1);
  }

  if (!fs.existsSync(imagePath)) {
    console.error(`❌ File không tồn tại: ${imagePath}`);
    process.exit(1);
  }

  console.log('🏥 Check ddddocr API...');
  const healthy = await ddddocr.healthCheck();
  if (!healthy) {
    console.error('❌ ddddocr API không hoạt động. Hãy chạy ddddocr trước.');
    process.exit(1);
  }
  console.log('  ✓ OK');

  const buffer = fs.readFileSync(imagePath);
  console.log(`\n📸 Đọc ảnh: ${imagePath} (${buffer.length} bytes)`);
  console.log(`🎯 Charset range: ${charsetRange}`);

  // Test nhiều lần để xem accuracy
  console.log('\n🔄 Chạy OCR 3 lần để kiểm tra consistency:');
  const results = [];
  for (let i = 1; i <= 3; i++) {
    const start = Date.now();
    const result = await ddddocr.solveTextCaptcha(buffer, { charsetRange });
    const elapsed = Date.now() - start;
    console.log(`  ${i}. "${result}" (${elapsed}ms)`);
    results.push(result);
  }

  // Check xem có consistent không
  const allSame = results.every((r) => r === results[0]);
  console.log(`\n${allSame ? '✅' : '⚠️'} Kết quả ${allSame ? 'nhất quán' : 'KHÔNG nhất quán (OCR không deterministic với ảnh này)'}`);

  const valid = ddddocr.isValidCaptcha(results[0]);
  console.log(`${valid ? '✅' : '⚠️'} Kết quả ${valid ? 'hợp lệ' : 'KHÔNG hợp lệ'} về định dạng (4-6 ký tự alphanumeric)`);
}

main().catch((err) => {
  console.error('❌ Lỗi:', err.message);
  process.exit(1);
});
