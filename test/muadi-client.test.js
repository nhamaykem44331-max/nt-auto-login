'use strict';

jest.mock('axios');
jest.mock('../src/config', () => ({
  paths: { sessionFile: './test/fixtures/sample-session.json' },
  browser: {},
  ddddocr: { apiUrl: 'http://localhost:8001', timeout: 10000 },
}));

const axios = require('axios');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  encryptMuadi,
  isInvalidTokenResponse,
  readStorageState,
  updateSessionTokens,
  MuadiApiClient,
  MuadiApiError,
} = require('../src/muadi-client');

const FIXTURE_SESSION = path.join(__dirname, 'fixtures/sample-session.json');

// --- encryptMuadi ---
describe('encryptMuadi', () => {
  it('returns a non-empty base64 string for a simple input', () => {
    const result = encryptMuadi('hello');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(() => Buffer.from(result, 'base64')).not.toThrow();
  });

  it('is deterministic — same input produces same output', () => {
    expect(encryptMuadi('hello')).toBe(encryptMuadi('hello'));
    expect(encryptMuadi('test123')).toBe(encryptMuadi('test123'));
  });

  it('different inputs produce different outputs', () => {
    expect(encryptMuadi('hello')).not.toBe(encryptMuadi('world'));
  });

  it('handles empty string', () => {
    const result = encryptMuadi('');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles Vietnamese text with diacritics', () => {
    const result = encryptMuadi('Nguyễn Văn A');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(encryptMuadi('Nguyễn Văn A')).toBe(encryptMuadi('Nguyễn Văn A'));
  });

  it('handles large JSON object', () => {
    const obj = { key: 'value', arr: [1, 2, 3], nested: { a: 1 } };
    const result = encryptMuadi(JSON.stringify(obj));
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('coerces null to string "null"', () => {
    const result = encryptMuadi(null);
    expect(result).toBe(encryptMuadi('null'));
  });

  it('coerces undefined to string "undefined"', () => {
    const result = encryptMuadi(undefined);
    expect(result).toBe(encryptMuadi('undefined'));
  });

  it('coerces numbers', () => {
    const result = encryptMuadi(12345);
    expect(result).toBe(encryptMuadi('12345'));
  });
});

// --- readStorageState ---
describe('readStorageState', () => {
  it('reads and parses the fixture session file correctly', () => {
    const state = readStorageState(FIXTURE_SESSION);
    expect(state.accessToken).toBe('fake-access-token-abc123');
    expect(state.refreshToken).toBe('fake-refresh-token-xyz789');
    expect(state.diff).toBe(0);
    expect(state.userInfo).toEqual({ email: 'test@example.com', dienThoai: '0901234567' });
    expect(state.agentInfo).toEqual({ agentEmail: 'agent@example.com', telephone: '0987654321' });
    expect(state.additionalFees).toEqual({ ADT: 50000, CHD: 50000, INF: 0 });
  });

  it('throws when session file does not exist', () => {
    expect(() => readStorageState('/nonexistent/path/file.json'))
      .toThrow(/not found|Session file/i);
  });

  it('throws when JSON is malformed', () => {
    const tmpFile = path.join(__dirname, 'fixtures/_tmp_bad.json');
    fs.writeFileSync(tmpFile, '{ invalid json }');
    try {
      expect(() => readStorageState(tmpFile)).toThrow();
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('throws when accessToken is missing', () => {
    const tmpFile = path.join(__dirname, 'fixtures/_tmp_no_token.json');
    const state = {
      origins: [{
        origin: 'https://booking.namthanh.vn',
        localStorage: [{ name: 'diff', value: '0' }],
      }],
    };
    fs.writeFileSync(tmpFile, JSON.stringify(state));
    try {
      expect(() => readStorageState(tmpFile)).toThrow(/accessToken/i);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('throws when no origin entry for booking.namthanh.vn', () => {
    const tmpFile = path.join(__dirname, 'fixtures/_tmp_no_origin.json');
    fs.writeFileSync(tmpFile, JSON.stringify({ origins: [] }));
    try {
      expect(() => readStorageState(tmpFile)).toThrow(/localStorage|origin/i);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

// --- isInvalidTokenResponse ---
describe('isInvalidTokenResponse', () => {
  it('returns true for status 401 with code 12', () => {
    expect(isInvalidTokenResponse(401, { code: '12', message: '' })).toBe(true);
  });

  it('returns true for status 401 with code 18', () => {
    expect(isInvalidTokenResponse(401, { code: '18', message: '' })).toBe(true);
  });

  it('returns true for status 401 with token in message', () => {
    expect(isInvalidTokenResponse(401, { code: '99', message: 'Token không hợp lệ' })).toBe(true);
    expect(isInvalidTokenResponse(401, { code: '99', message: 'Token expired' })).toBe(true);
    expect(isInvalidTokenResponse(401, { code: '99', message: 'invalid token detected' })).toBe(true);
  });

  it('returns false for non-401 status', () => {
    expect(isInvalidTokenResponse(200, { code: '12', message: '' })).toBe(false);
    expect(isInvalidTokenResponse(500, { code: '12', message: '' })).toBe(false);
  });

  it('returns true for success=false token responses even when HTTP status is 200', () => {
    expect(isInvalidTokenResponse(200, { success: false, message: 'Create token failed !!!' })).toBe(true);
    expect(isInvalidTokenResponse(200, { success: false, code: '18', message: '' })).toBe(true);
  });

  it('returns false for success=false responses that are not token errors', () => {
    expect(isInvalidTokenResponse(200, { success: false, message: 'No flight available' })).toBe(false);
  });

  it('returns false for 401 without matching code or message', () => {
    expect(isInvalidTokenResponse(401, { code: '99', message: 'Server error' })).toBe(false);
    expect(isInvalidTokenResponse(401, null)).toBe(false);
  });
});

// --- MuadiApiClient ---
describe('MuadiApiClient', () => {
  let client;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new MuadiApiClient({ sessionFile: FIXTURE_SESSION });
  });

  describe('buildHeaders', () => {
    it('includes all required headers', () => {
      const headers = client.buildHeaders();
      expect(headers).toHaveProperty('authorization', 'fake-access-token-abc123');
      expect(headers).toHaveProperty('tsp');
      expect(headers).toHaveProperty('Client-Type', 'Web');
      expect(headers).toHaveProperty('X-Language');
      expect(headers).toHaveProperty('Content-Type', 'application/json');
      expect(headers).toHaveProperty('Origin', 'https://booking.namthanh.vn');
    });

    it('tsp is a non-empty encrypted string', () => {
      const headers = client.buildHeaders();
      expect(typeof headers.tsp).toBe('string');
      expect(headers.tsp.length).toBeGreaterThan(0);
    });

    it('X-Api-Version matches version argument', () => {
      const h1 = client.buildHeaders('2');
      expect(h1['X-Api-Version']).toBe('2');
      const h3 = client.buildHeaders('3');
      expect(h3['X-Api-Version']).toBe('3');
    });
  });

  describe('post', () => {
    it('returns data on 200 success', async () => {
      axios.post.mockResolvedValue({
        status: 200,
        headers: {},
        data: { success: true, data: { sessionID: 99 } },
      });
      const result = await client.post('booking/create-session', { test: 1 });
      expect(result).toEqual({ success: true, data: { sessionID: 99 } });
      expect(axios.post).toHaveBeenCalledTimes(1);
    });

    it('encrypts body by default', async () => {
      axios.post.mockResolvedValue({ status: 200, headers: {}, data: { success: true } });
      await client.post('some/path', { foo: 'bar' });
      const callArgs = axios.post.mock.calls[0];
      expect(callArgs[1]).toHaveProperty('encrypted');
      expect(typeof callArgs[1].encrypted).toBe('string');
    });

    it('throws MuadiApiError on 401 token response', async () => {
      axios.post.mockResolvedValue({
        status: 401,
        headers: {},
        data: { code: '12', message: 'Token không hợp lệ' },
      });
      await expect(client.post('test/path')).rejects.toBeInstanceOf(MuadiApiError);
    });

    it('throws MuadiApiError on 500 server error', async () => {
      axios.post.mockResolvedValue({
        status: 500,
        headers: {},
        data: { message: 'Internal server error' },
      });
      await expect(client.post('test/path')).rejects.toBeInstanceOf(MuadiApiError);
    });

    it('throws MuadiApiError on network timeout', async () => {
      axios.post.mockRejectedValue(new Error('timeout of 120000ms exceeded'));
      await expect(client.post('test/path')).rejects.toBeInstanceOf(MuadiApiError);
    });

    it('throws MuadiApiError when success=false in response body', async () => {
      axios.post.mockResolvedValue({
        status: 200,
        headers: {},
        data: { success: false, message: 'Something went wrong' },
      });
      await expect(client.post('test/path')).rejects.toBeInstanceOf(MuadiApiError);
    });

    it('retries after successful token refresh on 401', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-refresh-retry-${Date.now()}.json`);
      fs.copyFileSync(FIXTURE_SESSION, tmpFile);
      const c = new MuadiApiClient({ sessionFile: tmpFile });
      try {
        axios.post
          .mockResolvedValueOnce({ status: 401, headers: {}, data: { code: '12', message: 'Token expired' } })
          .mockResolvedValueOnce({ status: 200, data: { accessToken: 'new-access', refreshToken: 'new-refresh' } })
          .mockResolvedValue({ status: 200, headers: {}, data: { success: true, result: 42 } });

        const result = await c.post('some/path', {});
        expect(result).toEqual({ success: true, result: 42 });
        expect(c.accessToken).toBe('new-access');
      } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      }
    });

    it('retries after successful token refresh on HTTP 200 Create token failed response', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-create-token-retry-${Date.now()}.json`);
      fs.copyFileSync(FIXTURE_SESSION, tmpFile);
      const c = new MuadiApiClient({ sessionFile: tmpFile });
      try {
        axios.post
          .mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: { success: false, message: 'Create token failed !!!' },
          })
          .mockResolvedValueOnce({
            status: 200,
            data: { success: true, data: { accessToken: 'new-access', refreshToken: 'new-refresh' } },
          })
          .mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: { success: true, data: { sessionID: 123 } },
          });

        const result = await c.post('booking/create-session', {}, { safeToRetry: true });

        expect(result).toEqual({ success: true, data: { sessionID: 123 } });
        expect(c.accessToken).toBe('new-access');
        expect(axios.post).toHaveBeenCalledTimes(3);
      } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      }
    });

    it('does not refresh for non-token success=false responses', async () => {
      axios.post.mockResolvedValue({
        status: 200,
        headers: {},
        data: { success: false, message: 'No flight available' },
      });
      const spy = jest.spyOn(client, 'tryRefreshToken');
      await expect(client.post('test/path')).rejects.toBeInstanceOf(MuadiApiError);
      expect(spy).not.toHaveBeenCalled();
    });

    it('throws MuadiApiError after 401 when all refresh variants fail', async () => {
      axios.post.mockResolvedValue({ status: 401, headers: {}, data: { code: '12', message: 'Token expired' } });
      await expect(client.post('some/path', {})).rejects.toBeInstanceOf(MuadiApiError);
    });

    it('does not call tryRefreshToken when _retried:true', async () => {
      axios.post.mockResolvedValue({ status: 401, headers: {}, data: { code: '12', message: 'Token expired' } });
      const spy = jest.spyOn(client, 'tryRefreshToken');
      await expect(client.post('some/path', {}, { _retried: true })).rejects.toBeInstanceOf(MuadiApiError);
      expect(spy).not.toHaveBeenCalled();
    });

    it('uses a 90 second timeout for createBooking by default', async () => {
      axios.post.mockResolvedValue({ status: 200, headers: {}, data: { success: true } });

      await client.createBooking({ sessionID: 123 });

      expect(axios.post.mock.calls[0][0]).toMatch(/booking\/create-booking$/);
      expect(axios.post.mock.calls[0][2].timeout).toBe(90000);
      expect(axios.post.mock.calls[0][2].headers['X-Api-Version']).toBe('3');
    });

    it('maps ancillaries payload to Routes + ADT/CHD/INF', async () => {
      axios.post.mockResolvedValue({ status: 200, headers: {}, data: { success: true, data: { segments: [] } } });
      await client.getAncillaries({
        sessionID: 88,
        listRoutes: [{ id: 'route-1' }],
        adt: 2,
        chd: 1,
        inf: 0,
      });

      const args = axios.post.mock.calls[0];
      expect(args[0]).toMatch(/booking\/ancillaries$/);
      expect(args[2].headers['X-Api-Version']).toBe('3');
      expect(args[1]).toHaveProperty('encrypted');
    });
  });
});

// --- updateSessionTokens ---
describe('updateSessionTokens', () => {
  let tmpFile;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `test-update-tokens-${Date.now()}.json`);
    fs.copyFileSync(FIXTURE_SESSION, tmpFile);
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it('updates accessToken and refreshToken, leaves other items intact', () => {
    updateSessionTokens(tmpFile, 'new-access-token', 'new-refresh-token');
    const updated = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    const ls = updated.origins[0].localStorage;
    const find = (name) => ls.find((i) => i.name === name);
    expect(find('accessToken').value).toBe('new-access-token');
    expect(find('refreshToken').value).toBe('new-refresh-token');
    expect(find('diff').value).toBe('0');
  });

  it('leaves refreshToken unchanged when newRefreshToken is falsy', () => {
    updateSessionTokens(tmpFile, 'new-access-only', null);
    const updated = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    const ls = updated.origins[0].localStorage;
    const find = (name) => ls.find((i) => i.name === name);
    expect(find('accessToken').value).toBe('new-access-only');
    expect(find('refreshToken').value).toBe('fake-refresh-token-xyz789');
  });

  it('throws if no matching origin in file', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ origins: [{ origin: 'https://other.com', localStorage: [] }] }));
    expect(() => updateSessionTokens(tmpFile, 'a', 'b')).toThrow(/origin/i);
  });
});

// --- MuadiApiClient.tryRefreshToken ---
describe('MuadiApiClient.tryRefreshToken', () => {
  let client;
  let tmpFile;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpFile = path.join(os.tmpdir(), `test-try-refresh-${Date.now()}.json`);
    fs.copyFileSync(FIXTURE_SESSION, tmpFile);
    client = new MuadiApiClient({ sessionFile: tmpFile });
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it('returns true and updates accessToken on success (nested data shape)', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: { success: true, data: { accessToken: 'refreshed-access', refreshToken: 'refreshed-refresh' } },
    });
    const result = await client.tryRefreshToken();
    expect(result).toBe(true);
    expect(client.accessToken).toBe('refreshed-access');
    expect(client.session.refreshToken).toBe('refreshed-refresh');
  });

  it('returns true when response has flat shape (no data wrapper)', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: { accessToken: 'flat-access', refreshToken: 'flat-refresh' },
    });
    const result = await client.tryRefreshToken();
    expect(result).toBe(true);
    expect(client.accessToken).toBe('flat-access');
  });

  it('returns false when all variants return non-200', async () => {
    axios.post.mockResolvedValue({ status: 401, data: { message: 'expired' } });
    const result = await client.tryRefreshToken();
    expect(result).toBe(false);
    expect(client.accessToken).toBe('fake-access-token-abc123');
  });

  it('returns false and does not call axios when session has no refreshToken', async () => {
    client.session.refreshToken = undefined;
    const result = await client.tryRefreshToken();
    expect(result).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('persists refreshed tokens to session file', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: { accessToken: 'persisted-access', refreshToken: 'persisted-refresh' },
    });
    await client.tryRefreshToken();
    const saved = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    const ls = saved.origins[0].localStorage;
    const find = (name) => ls.find((i) => i.name === name);
    expect(find('accessToken').value).toBe('persisted-access');
    expect(find('refreshToken').value).toBe('persisted-refresh');
  });
});
