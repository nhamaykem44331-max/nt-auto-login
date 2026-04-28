/**
 * auth-patch.js
 *
 * Fix lỗi: Request tới api-gateway.muadi.com.vn thiếu Authorization header
 *
 * Cơ chế: Intercept tất cả request đến api-gateway, đọc accessToken từ localStorage,
 * inject vào header 'authorization: <token>'.
 *
 * Sử dụng:
 *   const { patchAuthHeaders } = require('./auth-patch');
 *   await patchAuthHeaders(page);  // Gọi NGAY SAU khi login thành công
 */

/**
 * Patch page để auto-inject Authorization header vào mọi request API
 */
async function patchAuthHeaders(page) {
  // Đọc accessToken hiện tại từ localStorage
  const getToken = async () => {
    return await page.evaluate(() => localStorage.getItem('accessToken'));
  };

  // Kiểm tra token có sẵn
  const initialToken = await getToken();
  if (!initialToken) {
    console.warn('  ⚠️  Không có accessToken trong localStorage');
    return false;
  }

  console.log(`  ✓ Tìm thấy accessToken (${initialToken.length} chars)`);

  // Setup route interceptor
  await page.route('**/api-gateway.muadi.com.vn/**', async (route, request) => {
    const headers = { ...request.headers() };

    // Nếu chưa có authorization header, inject token từ localStorage
    if (!headers['authorization'] && !headers['Authorization']) {
      const token = await page.evaluate(() => localStorage.getItem('accessToken'));
      if (token) {
        headers['authorization'] = token;
        console.log(`  🔑 Injected Authorization vào: ${request.url().slice(0, 80)}`);
      }
    }

    // Continue request với headers đã modify
    await route.continue({ headers });
  });

  console.log('  ✅ Đã setup auto-inject Authorization header cho mọi API request');
  return true;
}

module.exports = { patchAuthHeaders };
