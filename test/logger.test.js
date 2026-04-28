'use strict';

// Each test block re-requires logger with fresh env to test MASK_PII behavior
function freshLogger(env = {}) {
  jest.resetModules();
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
  }
  const mod = require('../src/logger');
  return mod;
}

function cleanEnv() {
  delete process.env.MASK_PII;
  delete process.env.LOG_LEVEL;
}

afterEach(cleanEnv);

// --- maskName ---
describe('maskName', () => {
  it('masks "VU DUC ANH" → "V* D** A**"', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    expect(log.maskName('VU DUC ANH')).toBe('V* D** A**');
  });

  it('masks single word', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    expect(log.maskName('VU')).toBe('V*');
  });

  it('masks single letter word (keeps first char + 1 star)', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    expect(log.maskName('A')).toBe('A*');
  });

  it('returns empty string unchanged', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    expect(log.maskName('')).toBe('');
  });

  it('returns null/undefined unchanged', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    expect(log.maskName(null)).toBeNull();
    expect(log.maskName(undefined)).toBeUndefined();
  });

  it('MASK_PII=false returns original', () => {
    const log = freshLogger({ MASK_PII: 'false' });
    expect(log.maskName('VU DUC ANH')).toBe('VU DUC ANH');
  });
});

// --- maskPhone ---
describe('maskPhone', () => {
  it('masks "0943557959" → "094*****59"', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    expect(log.maskPhone('0943557959')).toBe('094*****59');
  });

  it('masks "+84943557959" keeping +84 prefix and last 2 digits', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    const result = log.maskPhone('+84943557959');
    expect(result).toMatch(/^\+84\*+59$/);
    expect(result).not.toContain('943557');
  });

  it('masks short strings (< 5 chars) entirely', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    const result = log.maskPhone('123');
    expect(result).toMatch(/^\*+$/);
  });

  it('returns empty string unchanged', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    expect(log.maskPhone('')).toBe('');
  });

  it('MASK_PII=false returns original', () => {
    const log = freshLogger({ MASK_PII: 'false' });
    expect(log.maskPhone('0943557959')).toBe('0943557959');
  });
});

// --- maskEmail ---
describe('maskEmail', () => {
  it('masks "tkt.tanphu@gmail.com" keeping first char and domain', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    const result = log.maskEmail('tkt.tanphu@gmail.com');
    expect(result).toMatch(/^t\*+@gmail\.com$/);
    expect(result).not.toContain('kt.tanphu');
  });

  it('masks single-char local part "a@b.com" → "a*@b.com"', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    expect(log.maskEmail('a@b.com')).toBe('a*@b.com');
  });

  it('returns non-email strings unchanged', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    expect(log.maskEmail('not-an-email')).toBe('not-an-email');
    expect(log.maskEmail('')).toBe('');
  });

  it('MASK_PII=false returns original', () => {
    const log = freshLogger({ MASK_PII: 'false' });
    expect(log.maskEmail('tkt.tanphu@gmail.com')).toBe('tkt.tanphu@gmail.com');
  });
});

// --- maskPII ---
describe('maskPII', () => {
  it('masks email pattern in text', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    const result = log.maskPII('Contact: user@example.com for details');
    expect(result).not.toContain('user@example.com');
    expect(result).toContain('@example.com');
  });

  it('masks phone number in text', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    const result = log.maskPII('Phone: 0943557959 please call');
    expect(result).not.toContain('0943557959');
    expect(result).toContain('094');
  });

  it('masks multiple PII patterns in one string', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    const result = log.maskPII('Email: a@b.com Phone: 0901234567');
    expect(result).not.toContain('a@b.com');
    expect(result).not.toContain('0901234567');
  });

  it('leaves non-PII text unchanged', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    const text = 'Flight VN205 HAN-SGN 05:00';
    expect(log.maskPII(text)).toBe(text);
  });

  it('MASK_PII=false returns original text', () => {
    const log = freshLogger({ MASK_PII: 'false' });
    const text = 'Email: user@example.com Phone: 0943557959';
    expect(log.maskPII(text)).toBe(text);
  });
});

// --- maskPassenger ---
describe('maskPassenger', () => {
  it('masks all PII fields in passenger object', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    const passenger = {
      firstName: 'DUC ANH',
      lastName: 'VU',
      fullName: 'VU DUC ANH',
      phone: '0943557959',
      phoneNumber: '0901234567',
      email: 'test@example.com',
      dienThoai: '0912345678',
      ngaySinh: '01-01-1990',
    };
    const masked = log.maskPassenger(passenger);
    expect(masked.firstName).not.toBe('DUC ANH');
    expect(masked.lastName).not.toBe('VU');
    expect(masked.phone).not.toBe('0943557959');
    expect(masked.email).not.toBe('test@example.com');
    expect(masked.email).toContain('@example.com');
  });

  it('does not mutate the original object', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    const passenger = { firstName: 'ANH', phone: '0943557959' };
    const masked = log.maskPassenger(passenger);
    expect(passenger.firstName).toBe('ANH');
    expect(passenger.phone).toBe('0943557959');
    expect(masked).not.toBe(passenger);
  });

  it('MASK_PII=false returns object with original values', () => {
    const log = freshLogger({ MASK_PII: 'false' });
    const passenger = { firstName: 'DUC ANH', phone: '0943557959' };
    const result = log.maskPassenger(passenger);
    expect(result.firstName).toBe('DUC ANH');
    expect(result.phone).toBe('0943557959');
  });
});

// --- log level filtering ---
describe('log level filtering', () => {
  it('LOG_LEVEL=warn suppresses info output', () => {
    const log = freshLogger({ LOG_LEVEL: 'warn', MASK_PII: 'true' });
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => {});
    log.info('this should not appear');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('LOG_LEVEL=warn allows warn output', () => {
    const log = freshLogger({ LOG_LEVEL: 'warn', MASK_PII: 'true' });
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => {});
    log.warn('this should appear');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('LOG_LEVEL=debug allows debug output', () => {
    const log = freshLogger({ LOG_LEVEL: 'debug', MASK_PII: 'true' });
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => {});
    log.debug('debug message');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('default LOG_LEVEL=info suppresses debug', () => {
    const log = freshLogger({ MASK_PII: 'true' });
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => {});
    log.debug('hidden debug');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
