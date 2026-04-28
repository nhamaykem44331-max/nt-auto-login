/**
 * ddddocr-client.js
 *
 * Wrapper gọi OCR custom API server.
 * Yêu cầu: OCR custom server đang chạy tại http://localhost:8001
 */

const axios = require('axios');
const config = require('./config');

class DdddocrClient {
  constructor() {
    this.client = axios.create({
      baseURL: config.ddddocr.apiUrl,
      timeout: config.ddddocr.timeout,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async healthCheck() {
    try {
      const response = await this.client.get('/health');
      return response.data?.status === 'ok' && response.data?.engine === 'ddddocr-custom';
    } catch (error) {
      return false;
    }
  }

  /**
   * Nhận diện captcha text từ Buffer ảnh
   */
  async solveTextCaptcha(imageBuffer, options = {}) {
    if (!Buffer.isBuffer(imageBuffer)) {
      throw new Error('imageBuffer phải là Buffer');
    }

    const base64 = imageBuffer.toString('base64');

    try {
      if (options.charsetRange !== undefined) {
        await this.setCharsetRange(options.charsetRange);
      }

      const response = await this.client.post('/ocr', {
        image: base64,
        probability: options.probability || false,
      });

      const result = response.data?.result;

      if (typeof result === 'string') {
        return this._cleanResult(result);
      } else if (result?.probability && result?.charsets) {
        let text = '';
        for (const probArray of result.probability) {
          const maxIdx = probArray.indexOf(Math.max(...probArray));
          text += result.charsets[maxIdx] || '';
        }
        return this._cleanResult(text);
      }

      throw new Error('Không parse được kết quả từ ddddocr');
    } catch (error) {
      if (error.response) {
        const responseText = JSON.stringify(error.response.data);
        if (/unexpected keyword argument ['"]colors['"]|colors/i.test(responseText)) {
          throw new Error(
            `Dang goi nham ddddocr API built-in tai ${config.ddddocr.apiUrl}. ` +
            `Hay chay OCR custom bang: npm run ocr, va dat DDDDOCR_API_URL=http://localhost:8001`
          );
        }
        throw new Error(
          `ddddocr API error (${error.response.status}): ${responseText}`
        );
      }
      throw new Error(`Không gọi được ddddocr API: ${error.message}`);
    }
  }

  async setCharsetRange(range) {
    const rangeMap = {
      0: '0123456789'.split(''),
      1: 'abcdefghijklmnopqrstuvwxyz'.split(''),
      2: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
      3: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
      4: 'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
      5: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
      6: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
    };

    const charsetRange = rangeMap[range];
    if (!charsetRange) return;

    try {
      await this.client.post('/set_charset_range', {
        charset_range: charsetRange,
      });
    } catch (error) {
      console.warn('⚠️  Không set được charset range:', error.message);
    }
  }

  _cleanResult(text) {
    return text.replace(/\s+/g, '').trim();
  }

  /**
   * Validate kết quả OCR
   * Captcha namthanh.vn: đúng 3 ký tự alphanumeric
   */
  isValidCaptcha(text, expectedLength = { min: 3, max: 3 }) {
    if (!text || typeof text !== 'string') return false;
    if (text.length < expectedLength.min || text.length > expectedLength.max) return false;
    if (!/^[a-zA-Z0-9]+$/.test(text)) return false;
    return true;
  }
}

module.exports = new DdddocrClient();
