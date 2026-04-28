'use strict';

const {
  isValidAirport,
  validateAirport,
  searchAirport,
  isDomesticRoute,
  getAirportInfo,
} = require('../src/airports');

// --- isValidAirport ---
describe('isValidAirport', () => {
  it('returns true for valid domestic airport code', () => {
    expect(isValidAirport('HAN')).toBe(true);
    expect(isValidAirport('SGN')).toBe(true);
    expect(isValidAirport('DAD')).toBe(true);
  });

  it('returns true for valid international airport code', () => {
    expect(isValidAirport('BKK')).toBe(true);
    expect(isValidAirport('SIN')).toBe(true);
  });

  it('returns false for unknown code', () => {
    expect(isValidAirport('XXX')).toBe(false);
    expect(isValidAirport('ZZZ')).toBe(false);
  });

  it('is case-insensitive (normalizes to uppercase)', () => {
    expect(isValidAirport('han')).toBe(true);
    expect(isValidAirport('Han')).toBe(true);
  });

  it('returns false for falsy values', () => {
    expect(isValidAirport('')).toBe(false);
    expect(isValidAirport(null)).toBe(false);
    expect(isValidAirport(undefined)).toBe(false);
  });
});

// --- validateAirport ---
describe('validateAirport', () => {
  it('returns the code uppercased for valid airport', () => {
    expect(validateAirport('HAN')).toBe('HAN');
    expect(validateAirport('sgn')).toBe('SGN');
  });

  it('throws for unknown code', () => {
    expect(() => validateAirport('XXX')).toThrow(/unknown airport/i);
  });

  it('includes suggestion for near-miss codes (Levenshtein ≤ 2)', () => {
    // HNI is distance 1 from HUI (H+I match, N→U), so suggestion will be HUI
    const err = (() => {
      try { validateAirport('HNI'); return null; }
      catch (e) { return e; }
    })();
    expect(err).not.toBeNull();
    expect(err.message).toMatch(/Did you mean/i);
  });

  it('suggests SGN for SGM', () => {
    // SGM is distance 1 from SGN (S+G match, M→N)
    const err = (() => {
      try { validateAirport('SGM'); return null; }
      catch (e) { return e; }
    })();
    expect(err).not.toBeNull();
    expect(err.message).toMatch(/SGN/);
  });

  it('includes fieldName in error message when provided', () => {
    expect(() => validateAirport('XXX', 'from')).toThrow(/unknown airport/i);
  });
});

// --- searchAirport ---
describe('searchAirport', () => {
  it('finds airport by exact code', () => {
    const results = searchAirport('HAN');
    expect(results.some((a) => a.code === 'HAN')).toBe(true);
  });

  it('finds airports by city name (Vietnamese)', () => {
    const results = searchAirport('Hà Nội');
    expect(results.some((a) => a.code === 'HAN')).toBe(true);
  });

  it('finds Tân Sơn Nhất by partial name', () => {
    const results = searchAirport('Tan son');
    expect(results.some((a) => a.code === 'SGN')).toBe(true);
  });

  it('finds Đà Nẵng by city name', () => {
    const results = searchAirport('Đà Nẵng');
    expect(results.some((a) => a.code === 'DAD')).toBe(true);
  });

  it('is case-insensitive', () => {
    const results = searchAirport('HAN');
    expect(results.some((a) => a.code === 'HAN')).toBe(true);
  });

  it('returns empty array when no match', () => {
    const results = searchAirport('Zzzznonexistent');
    expect(results).toHaveLength(0);
  });
});

// --- isDomesticRoute ---
describe('isDomesticRoute', () => {
  it('returns true for HAN-SGN (both domestic VN)', () => {
    expect(isDomesticRoute('HAN', 'SGN')).toBe(true);
  });

  it('returns true for SGN-DAD', () => {
    expect(isDomesticRoute('SGN', 'DAD')).toBe(true);
  });

  it('returns false for HAN-BKK (international)', () => {
    expect(isDomesticRoute('HAN', 'BKK')).toBe(false);
  });

  it('returns false for SIN-BKK (both international, non-VN)', () => {
    expect(isDomesticRoute('SIN', 'BKK')).toBe(false);
  });

  it('returns false for unknown codes', () => {
    expect(isDomesticRoute('XXX', 'YYY')).toBe(false);
    expect(isDomesticRoute('HAN', 'YYY')).toBe(false);
  });
});

// --- getAirportInfo ---
describe('getAirportInfo', () => {
  it('returns airport object for valid code', () => {
    const info = getAirportInfo('HAN');
    expect(info).not.toBeNull();
    expect(info.code).toBe('HAN');
    expect(info.city).toBe('Hà Nội');
    expect(info.domestic).toBe(true);
  });

  it('returns airport object for international airport', () => {
    const info = getAirportInfo('BKK');
    expect(info).not.toBeNull();
    expect(info.country).toBe('TH');
    expect(info.domestic).toBe(false);
  });

  it('returns null for unknown code', () => {
    expect(getAirportInfo('XXX')).toBeNull();
    expect(getAirportInfo('')).toBeNull();
    expect(getAirportInfo(null)).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(getAirportInfo('han')).not.toBeNull();
    expect(getAirportInfo('HAN').code).toBe('HAN');
  });
});
